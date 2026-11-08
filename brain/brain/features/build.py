"""
The offline entry features of every episode, point in time:  python -m brain.features.build

    derived/features_entry/day=YYYY-MM-DD/part-NN.parquet   one row per episode: episode_id, leader, mint, ts, period,
                                                           known_at_t, crosses_outage, ins_lag_sec, stored_late,
                                                           leader_sol, gate, then every entry feature's RAW value
                                                           (NaN = missing; venue_group a level string)
    derived/features_entry_meta.json                       the column layout, venue_group levels and norm (mean/std)
                                                           from FIT training rows, counts, gate pass rates, timing
    derived/active_wallets_hourly.parquet                  (h, n): tracked wallets delivered per UTC hour (epoch s of
                                                           the hour start; NaN = no process saw it, active_hours), what
                                                           tracked_active_wallets_1h reads; the simulator's exit
                                                           features read it through active_wallets_1h(t)

Load:  load_entry(where="period = 'fit' AND known_at_t AND NOT crosses_outage AND gate IS NULL") -> raw frame;
       matrix(frame) -> the normalised [n, columns] float32 matrix the entry network sees.

The definitions are brain/spec/features.yaml; entry.py is the per-buy reference and the tests check this build
against it episode by episode. Decision time t = T + DECISION_LAG_SEC (T = the leader's block time). A swap counts at t
when its block time is in the window and its insert time (derive's ins_ts proxy) is before t; that makes every window
an interval in T (intervals.py), so the whole build is sorts and binary searches, mint by mint and leader by leader:

    1  split swaps into mint buckets (derive.split_swaps) and episodes the same way
    2  per mint bucket: point-in-time ok prices (bucket_swaps), first sightings, the 5-min crowd, the highs, the leader's
       same-second sells, and the ledger rows (mirror / ps / dd) of every copy-eligible buy; the leaders' own swaps
       and the ledger rows go on, split by leader
    3  per leader bucket: the wallet_swaps scan features and the ledger features
    4  creators and token_info, the hourly active wallets
    5  per day: join, swap fields, gates -> features_entry; then the fit-only levels and norm

Resources: duckdb under the team limits (1200MB, 2 threads, temp on the drive), pandas per bucket / day chunk.
Staging lives in DATA_DIR/tmp/features_build/ (re-runnable with --resume); the result replaces derived/features_entry
only at the end.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from brain.data import derive, splits
from brain.data.loaders import configure, data_dir, derived_dir, export_dir, has_parquet, parquet_glob, present_columns, sql_str, swap_sources
from brain.features import entry as fe
from brain.features import intervals as iv
from brain.features import spec

DECISION_LAG_SEC = 1  # t = T + 1 s (stream lateness p50 0.77 s); leader_sold_at_decision assumes exactly 1
N_MINT_BUCKETS = 64  # ~320k swaps per bucket: pandas stays well under 2 GB
N_LEADER_BUCKETS = 16
EPS_PER_PASS = 8  # mint buckets written per pass when splitting episodes
DAY = 86_400
W7 = 7 * DAY
RING_SEC = 3_600
FLOW_SEC = int(fe.FLOW_SEC)
HIGH_CUT = int(fe.HIGH_CUT_SEC)
FLIP = int(fe.FLIP_SEC)
FIRST_PRICE_MIN_SOL = 0.01
# the mirror ledger (ledger.ts)
ENTRY_FROM, ENTRY_TO = 15, 135
EXIT_AFTER_SELL = 15
MIRROR_STOP = -0.6
HOLD = DAY
GROUNDED = 6 * 3_600
MIRROR_COST = 0.026
PS_AVAIL = 61 * 60
DD_FROM, DD_TO, DD_AVAIL = 3_600, 7_200, 2 * 3_600 + 15
KIND_MIRROR, KIND_PS, KIND_DD = 0, 1, 2
CHUNK_ROWS = 400_000  # assembly: episodes per chunk
TRAIN_WHERE = "period = 'fit' AND known_at_t AND NOT crosses_outage AND gate IS NULL"
META_NAME = "features_entry_meta.json"
OUT_NAME = "features_entry"
HOURLY_NAME = "active_wallets_hourly.parquet"
DIP_SHARE = 0.1  # an hour delivering under 10 % of the wallets of both its neighbours had an outage inside it
S = iv.SHIFT


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def _i64(x) -> np.ndarray:
    return np.asarray(x, dtype=np.int64)


def leader_bucket(wallets, n: int = N_LEADER_BUCKETS) -> np.ndarray:
    """A stable bucket per wallet (pandas' hash): the leader stage gets all of a leader's rows from every mint bucket."""
    return (pd.util.hash_array(np.asarray(wallets, dtype=object)) % np.uint64(n)).astype(np.int64)


def utc_day(t) -> np.ndarray:
    return _i64(t) // DAY


# ---------------------------------------------------------------------------------------------------------------------
# Stage 2: one mint bucket


def bucket_swaps(con: duckdb.DuckDBPyConnection, extra: tuple[str, ...] = ()) -> pd.DataFrame:
    """
    The swaps of temp table `sw` (derive.prepare_swaps) as mint_stage reads them (id, wallet, mint, side, t, a = ins_t,
    okey, sol, price, tokens, ok, plus the `extra` columns of sw), with the POINT-IN-TIME ok flag: derive.build_prices'
    trailing filter fed each mint's swaps in ARRIVAL order (ins_t, id), as state.ts TrailingFilter.accept sees them
    live, so a swap's flag depends only on swaps stored no later than it. derive's own `ok` is fed in block-time order,
    so an earlier-ts swap backfilled after t can flip the flag of a swap the server had before t; it stays derive's,
    for labels and the simulator. Leaves `sw` as it was and drops build_prices' temp tables.
    """
    con.execute("ALTER TABLE sw RENAME TO sw_ts")
    con.execute("""
        CREATE TEMP TABLE sw AS
        SELECT * REPLACE (row_number() OVER (PARTITION BY mint ORDER BY ins_t, id, okey) AS okey), okey AS tkey FROM sw_ts
    """)
    derive.build_prices(con)  # px.okey = the arrival rank
    df = con.execute(f"""
        SELECT s.id, s.wallet, s.mint, s.side, s.t, s.ins_t AS a, s.tkey AS okey, s.sol_amount AS sol, s.price_sol AS price,
               s.token_amount AS tokens, p.ok{''.join(', s.' + c for c in extra)}
        FROM sw s JOIN px p ON p.mint = s.mint AND p.okey = s.okey
    """).df()
    con.execute("DROP TABLE IF EXISTS sw; DROP TABLE IF EXISTS px; DROP TABLE IF EXISTS pxs; ALTER TABLE sw_ts RENAME TO sw")
    return df


def mint_stage(sw: pd.DataFrame, eps: pd.DataFrame, lag: int = DECISION_LAG_SEC) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    sw: the bucket's swaps (id, wallet, mint, side, t, a = ins_t, okey, sol, price, tokens, ok = the point-in-time flag
    of bucket_swaps); eps: its episodes (episode_id, leader_pos_tokens). Returns (per-episode coin features, per-mint
    sighting, ledger rows).
    """
    if lag != 1:
        raise ValueError("leader_sold_at_decision is built for a 1 s decision lag only")
    sw = sw.sort_values(["mint", "okey"], kind="stable").reset_index(drop=True)
    n = len(sw)
    m = pd.factorize(sw["mint"])[0].astype(np.int64)
    w = pd.factorize(sw["wallet"])[0].astype(np.int64)
    t, a = _i64(sw["t"]), _i64(sw["a"])
    buy = (sw["side"] == "buy").to_numpy()
    sol = sw["sol"].to_numpy(dtype=np.float64)
    price = sw["price"].to_numpy(dtype=np.float64)
    tokens = np.nan_to_num(sw["tokens"].to_numpy(dtype=np.float64))
    ok = sw["ok"].to_numpy(dtype=bool)
    pos = np.arange(n, dtype=np.int64)
    gstart = np.flatnonzero(np.concatenate([[True], m[1:] != m[:-1]]))
    mints = sw["mint"].to_numpy()[gstart]

    pe = pd.Series(pos, index=sw["id"].to_numpy()).reindex(eps["episode_id"].to_numpy()).to_numpy()
    if np.isnan(pe.astype(np.float64)).any():
        raise ValueError("episode ids missing from the bucket's swaps")
    pe = pe.astype(np.int64)
    eT, em, ew, eA = t[pe], m[pe], w[pe], a[pe]
    esol, eprice = sol[pe], price[pe]
    tq = eT + lag
    out = pd.DataFrame({"episode_id": eps["episode_id"].to_numpy()})

    # ---- first sighting: S = the first insert time; first_seen_at and the first ok price as state.ts records them
    S_m = np.minimum.reduceat(a, gstart)
    S_row = S_m[m]
    at_sight = (a <= S_row) & (t >= S_row - W7)
    big = np.iinfo(np.int64).max
    fts_m = np.minimum.reduceat(np.where(at_sight, t, big), gstart)
    fts_m = np.where(fts_m == big, S_m, fts_m)  # nothing stored within 7 d: first seen = the sighting itself
    q = ok & (sol >= FIRST_PRICE_MIN_SOL)
    p0 = np.minimum.reduceat(np.where(q & at_sight, pos, big), gstart)  # earliest by (ts, slot, id) among stored rows
    later = pd.DataFrame({"m": m[q & ~at_sight & (a > S_row)], "a": a[q & ~at_sight & (a > S_row)], "pos": pos[q & ~at_sight & (a > S_row)]})
    p1 = np.full(len(gstart), big)
    if len(later):
        first = later.sort_values(["m", "a", "pos"], kind="stable").groupby("m", sort=False)["pos"].first()
        p1[first.index.to_numpy()] = first.to_numpy()
    has0, has1 = p0 != big, p1 != big
    fop_m = np.where(has0, price[np.where(has0, p0, 0)], np.where(has1, price[np.where(has1, p1, 0)], np.nan))
    foa_m = np.where(has0, t[np.where(has0, p0, 0)], np.where(has1, a[np.where(has1, p1, 0)], big))
    sighted = S_m[em] < tq
    fts = fts_m[em]
    out["mint_first_seen_age_min"] = np.where(sighted & (fts < eT), np.minimum(fe.AGE_CAP_MIN, (tq - fts) / 60.0), np.nan)
    fop, foa = fop_m[em], foa_m[em]
    with np.errstate(divide="ignore", invalid="ignore"):
        out["ret_since_first"] = np.where(sighted & (foa < eT) & (fop > 0) & (eprice > 0), np.log(eprice / fop), np.nan)

    # ---- the 5-min crowd: ok buys by others with ts in [T - 5 min, T), stored before t
    cb = ok & buy
    s_c, e_c = np.maximum(t[cb], a[cb] - lag), t[cb] + FLOW_SEC
    pair_keys = np.concatenate([m[cb] * (w.max() + 1) + w[cb], em * (w.max() + 1) + ew])
    pair = pd.factorize(pair_keys)[0].astype(np.int64)
    ipair, qpair = pair[: cb.sum()], pair[cb.sum():]
    pair_mint = np.concatenate([m[cb], em])
    mint_of_pair = np.zeros(pair.max() + 1 if len(pair) else 0, dtype=np.int64)
    mint_of_pair[pair] = pair_mint
    G, Si, Ei = iv.islands(ipair, s_c, e_c)
    distinct = iv.stab(mint_of_pair[G], Si, Ei, em, eT)
    mine = iv.stab(G, Si, Ei, qpair, eT)
    out["m_buyers_5m"] = distinct - mine
    out["m_buysol_5m"] = np.maximum(0.0, iv.stab(m[cb], s_c, e_c, em, eT, sol[cb]) - iv.stab(ipair, s_c, e_c, qpair, eT, sol[cb]))

    # ---- the high before the last minute: ok prices with ts in [T - 7 d, T - 60 s), stored before t
    out["dd_from_high"] = np.nan
    hi = iv.stab_max(m[ok], np.maximum(t[ok] + HIGH_CUT, a[ok] - lag), t[ok] + W7, price[ok], em, eT)
    with np.errstate(divide="ignore", invalid="ignore"):
        out["dd_from_high"] = np.where(np.isfinite(hi) & (eprice > 0), np.log(eprice / hi), np.nan)

    # ---- what the leader sold by t: its sells after the buy in the same second, stored in that second (lag 1 s)
    sel = ~buy
    sp_keys = np.concatenate([m[sel] * (w.max() + 1) + w[sel], em * (w.max() + 1) + ew])
    sp = pd.factorize(sp_keys)[0].astype(np.int64)
    s_pair, e_pair = sp[: sel.sum()], sp[sel.sum():]
    sk = s_pair * S + pos[sel]
    o = np.argsort(sk, kind="stable")
    sk = sk[o]
    s_pos = pos[sel][o]
    cum = np.concatenate([[0.0], np.cumsum((tokens[sel] * (a[sel] == t[sel]))[o])])
    mk = m * S + t
    end_sec = np.searchsorted(mk, em * S + eT + 1, "left")  # first swap of the mint after the buy's second
    lo = np.searchsorted(sk, e_pair * S + pe, "right")
    hi_ = np.searchsorted(sk, e_pair * S + end_sec, "left")
    sold = np.where(hi_ > lo, cum[hi_] - cum[np.maximum(lo, 0)], 0.0)
    post = eps["leader_pos_tokens"].to_numpy(dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        out["leader_sold_at_decision"] = np.where(post > 0, np.clip(sold / post, 0.0, 1.0), 0.0)
    # the leader's next sell after each buy (any): the mirror's exit clock and the ps row
    ls_pos = np.full(len(pe), -1, dtype=np.int64)
    if len(sk):
        nxt = np.minimum(np.searchsorted(sk, e_pair * S + pe, "right"), len(sk) - 1)
        nxt_ok = (sk[nxt] // S == e_pair) & (s_pos[nxt] > pe)
        ls_pos = np.where(nxt_ok, s_pos[nxt], -1)

    ledger = ledger_rows(m, w, t, a, buy, price, ok, eT, em, ew, eA, esol, ls_pos)
    ledger["leader"] = sw["wallet"].to_numpy()[pe][ledger.pop("ep").to_numpy()]
    mint_tab = pd.DataFrame({"mint": mints, "S": S_m, "fts": fts_m})
    return out, mint_tab, ledger


def _next_other(gm: np.ndarray, gw: np.ndarray) -> np.ndarray:
    """For each row (sorted by mint, time): the index of the next row with a different (mint, wallet) run start."""
    n = len(gm)
    run = np.concatenate([[True], (gm[1:] != gm[:-1]) | (gw[1:] != gw[:-1])]) if n else np.zeros(0, dtype=bool)
    starts = np.append(np.flatnonzero(run), n)
    rid = np.cumsum(run) - 1
    return starts[rid + 1]


def ledger_rows(m, w, t, a, buy, price, ok, eT, em, ew, eA, esol, ls_pos) -> pd.DataFrame:
    """
    mirror / ps / dd rows of the copy-eligible episodes (ledger.ts rules over the mint's ok swaps in ts order). Each row's
    `at` (resolved_at / avail_at) is never before the insert time of anything it used, and with point-in-time ok flags
    (bucket_swaps) never before the insert time of anything those flags depend on.
    """
    el = np.flatnonzero(esol >= fe.MIN_LEADER_BUY_SOL)
    oi = np.flatnonzero(ok)
    Om, Ot, Oa, Ow, Op, Obuy = m[oi], t[oi], a[oi], w[oi], price[oi], buy[oi]
    key = Om * S + Ot
    nok = len(oi)
    rows = []
    if not len(el) or not nok:
        return pd.DataFrame({"kind": pd.Series(dtype=np.int8), "ep": pd.Series(dtype=np.int64), "at": pd.Series(dtype=np.int64),
                             "v": pd.Series(dtype=np.float64), "lr": pd.Series(dtype=np.float64)})
    T, M, W, A = eT[el], em[el], ew[el], eA[el]
    lim = np.searchsorted(key, (M + 1) * S, "left")  # end of the mint in the ok array
    clamp = lambda i: np.minimum(i, nok - 1)  # noqa: E731
    nother = _next_other(Om, Ow)

    # leader's first sell after the buy (any sell): its ts and insert time; it counts within 24 h
    has_ls = ls_pos[el] >= 0
    lsp = np.where(has_ls, ls_pos[el], 0)
    Ls, La = np.where(has_ls, t[lsp], 0), np.where(has_ls, a[lsp], 0)
    has_ls &= Ls <= T + HOLD

    # ---- mirror
    c = np.searchsorted(key, M * S + T + ENTRY_FROM, "left")
    c = np.where((c < lim) & (Ow[clamp(c)] == W), nother[clamp(c)], c)
    has_entry = (c < lim) & (Ot[clamp(c)] <= T + ENTRY_TO)
    ci = clamp(c)
    Et, Ep, Ea = Ot[ci], Op[ci], Oa[ci]
    lim24 = np.searchsorted(key, M * S + T + HOLD, "left")
    s0 = np.searchsorted(key, M * S + Et + 1, "left")
    level = Ep * (1 + MIRROR_STOP)
    j = np.full(len(el), -1, dtype=np.int64)
    if has_entry.any():
        blocks = iv._Blocks(Op)
        j[has_entry] = iv.first_le(Op, s0[has_entry], lim24[has_entry], level[has_entry], blocks)
    # the first ok sell by a non-leader from max(leader sell + 15 s, entry + 1 s)
    si = np.flatnonzero(~Obuy)
    Sm, St, Sw = Om[si], Ot[si], Ow[si]
    skey = Sm * S + St
    sother = _next_other(Sm, Sw)
    ns = len(si)
    X = np.maximum(Ls + EXIT_AFTER_SELL, Et + 1)
    slim = np.searchsorted(skey, (M + 1) * S, "left")
    c2 = np.searchsorted(skey, M * S + X, "left")
    if ns:
        c2 = np.where((c2 < slim) & (Sw[np.minimum(c2, ns - 1)] == W), sother[np.minimum(c2, ns - 1)], c2)
        has_exit = has_entry & has_ls & (c2 < slim) & (St[np.minimum(c2, ns - 1)] < T + HOLD)
        x = np.where(has_exit, si[np.minimum(c2, ns - 1)], -1)
    else:
        has_exit = np.zeros(len(el), dtype=bool)
        x = np.full(len(el), -1)
    has_stop = has_entry & (j >= 0)
    use_stop = has_stop & (~has_exit | (j <= x))
    use_exit = has_exit & ~use_stop
    g = np.searchsorted(key, M * S + T + HOLD, "left")
    gi = clamp(g)
    use_g = has_entry & ~use_stop & ~use_exit & (g < lim) & (Ot[gi] <= T + HOLD + GROUNDED)
    dead = has_entry & ~use_stop & ~use_exit & ~use_g
    d = np.where(use_stop, j, np.where(use_exit, x, gi))
    di = clamp(d)
    with np.errstate(divide="ignore", invalid="ignore"):
        y = np.where(dead, -1.0, Op[di] / Ep - 1 - MIRROR_COST)
    at = np.maximum.reduce([np.where(dead, T + HOLD + GROUNDED, Oa[di]), A, Ea, np.where(use_exit, La, 0)])
    k = np.flatnonzero(has_entry)
    rows.append(pd.DataFrame({"kind": KIND_MIRROR, "ep": el[k], "at": at[k], "v": y[k],
                              "lr": np.log(1.0 + np.clip(y[k], -0.99, 10.0))}))

    # ---- ps: the coin in the hour after the leader's first sell
    sm = Ls // 60 * 60
    end = sm + PS_AVAIL
    f = np.searchsorted(key, M * S + sm, "left")
    fin = has_ls & (f < lim) & (Ot[clamp(f)] < end)
    dark = has_ls & ~fin
    kbar = (Ot[clamp(f)] - sm) // 60
    usable = fin & (kbar <= 2)
    bar = sm + 60 * kbar
    cidx = np.searchsorted(key, M * S + bar + 60, "left") - 1
    aidx = np.searchsorted(key, M * S + end, "left") - 1
    has_after = usable & (aidx >= cidx + 1)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(has_after, np.clip(Op[clamp(aidx)] / Op[clamp(cidx)] - 1, -1.0, 10.0), -1.0)
    at_ps = np.maximum.reduce([end, A, La, np.where(usable, Oa[clamp(cidx)], 0), np.where(has_after, Oa[clamp(aidx)], 0)])
    k = np.flatnonzero(dark | usable)
    rows.append(pd.DataFrame({"kind": KIND_PS, "ep": el[k], "at": at_ps[k], "v": r[k], "lr": np.nan}))

    # ---- dd: silent 1-2 h after the buy
    f = np.searchsorted(key, M * S + T + DD_FROM, "left")
    alive = (f < lim) & (Ot[clamp(f)] < T + DD_TO)
    at_dd = np.maximum.reduce([T + DD_AVAIL, A, np.where(alive, Oa[clamp(f)], 0)])
    rows.append(pd.DataFrame({"kind": KIND_DD, "ep": el, "at": at_dd, "v": (~alive).astype(np.float64), "lr": np.nan}))
    out = pd.concat(rows, ignore_index=True)
    out["kind"] = out["kind"].astype(np.int8)
    out["at"] = out["at"].astype(np.int64)
    return out


def hourly_pairs(sw: pd.DataFrame) -> pd.DataFrame:
    """(hour, wallet) for swaps delivered during their own UTC hour (ts in it, insert time before it ends)."""
    h = _i64(sw["t"]) // 3_600 * 3_600
    keep = _i64(sw["a"]) < h + 3_600
    return pd.DataFrame({"h": h[keep], "wallet": sw["wallet"].to_numpy()[keep]}).drop_duplicates()


# ---------------------------------------------------------------------------------------------------------------------
# Stage 3: one leader bucket


def leader_stage(lsw: pd.DataFrame, eps: pd.DataFrame, ledger: pd.DataFrame, lag: int = DECISION_LAG_SEC) -> pd.DataFrame:
    """
    lsw: the bucket's leaders' stored swaps (wallet, mint, side, t, a, sol); eps: (episode_id, leader, T, sol);
    ledger: (kind, leader, at, v, lr). Returns the leader-scan and ledger features per episode.
    """
    codes, uniq = pd.factorize(pd.concat([lsw["wallet"], eps["leader"], ledger["leader"]], ignore_index=True))
    nl, ne = len(lsw), len(eps)
    lw, eg, lg = codes[:nl].astype(np.int64), codes[nl: nl + ne].astype(np.int64), codes[nl + ne:].astype(np.int64)
    eT = _i64(eps["T"])
    out = pd.DataFrame({"episode_id": eps["episode_id"].to_numpy()})
    t, a = _i64(lsw["t"]), _i64(lsw["a"])
    sol = lsw["sol"].to_numpy(dtype=np.float64)
    buy = (lsw["side"] == "buy").to_numpy()
    mc = pd.factorize(lsw["mint"])[0].astype(np.int64)

    # ---- the wallet_swaps scan: block time in [T - W, T), stored before t
    b = buy & (sol >= fe.MIN_STYLE_SOL)
    gb, tb, ab, sb, mb = lw[b], t[b], a[b], sol[b], mc[b]
    s = np.maximum(tb, ab - lag)
    n7 = iv.stab(gb, s, tb + W7, eg, eT)
    out["b_n_24h"] = iv.stab(gb, s, tb + DAY, eg, eT)
    with np.errstate(divide="ignore"):
        ln7 = iv.stab(gb, s, tb + W7, eg, eT, np.log(sb))
    pairs = pd.factorize(gb * (mc.max() + 1 if len(mc) else 1) + mb)[0].astype(np.int64)
    lead_of = np.zeros(pairs.max() + 1 if len(pairs) else 0, dtype=np.int64)
    lead_of[pairs] = gb
    P, Ps, Pe = iv.islands(pairs, s, tb + W7)
    distinct = iv.stab(lead_of[P], Ps, Pe, eg, eT)
    e_sol = eps["sol"].to_numpy(dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        out["b_first_7d"] = np.where(n7 > 0, distinct / np.maximum(n7, 1), np.nan)
        out["b_size_ratio"] = np.where((n7 > 0) & (e_sol > 0), np.log(e_sol) - ln7 / np.maximum(n7, 1), np.nan)
    big = sb >= fe.MIN_LEADER_BUY_SOL
    P, Ps, Pe = iv.islands(pairs[big], s[big], tb[big] + W7)
    out["leader_n_prior7"] = iv.stab(lead_of[P], Ps, Pe, eg, eT)

    # lf_flip60_7d: a buy counts from ts + 60 s; flipped when a sell of the mint by the leader has ts in [ts, ts + 60 s]
    sl = ~buy
    pk_all = lw * (mc.max() + 1 if len(mc) else 1) + mc
    pcode = pd.factorize(np.concatenate([pk_all[b], pk_all[sl]]))[0].astype(np.int64)
    pb, ps = pcode[: b.sum()], pcode[b.sum():]
    sk = ps * S + t[sl]
    o = np.argsort(sk, kind="stable")
    sk, sa = sk[o], a[sl][o].astype(np.float64)
    lo = np.searchsorted(sk, pb * S + tb, "left")
    hi = np.searchsorted(sk, pb * S + tb + FLIP, "right")
    amin = iv.range_min(sa, lo, hi) if len(sa) else np.full(len(tb), np.inf)
    s_den = np.maximum(tb + FLIP, ab - lag)
    flipped = np.isfinite(amin)
    s_num = np.maximum(s_den[flipped], np.where(flipped, amin, 0)[flipped].astype(np.int64) - lag)
    den = iv.stab(gb, s_den, tb + W7, eg, eT)
    num = iv.stab(gb[flipped], s_num, tb[flipped] + W7, eg, eT)
    out["lf_flip60_7d"] = np.where(den > 0, num / np.maximum(den, 1), np.nan)

    # ---- the ledgers: rows available in [t - 7 d, t)
    kind, at = ledger["kind"].to_numpy(), _i64(ledger["at"])
    v, lr = ledger["v"].to_numpy(dtype=np.float64), ledger["lr"].to_numpy(dtype=np.float64)
    st, en = at - lag, at - lag + W7
    mi = kind == KIND_MIRROR
    n = iv.stab(lg[mi], st[mi], en[mi], eg, eT)
    out["cp_n_7d"] = n
    out["cp_lrshr_7d"] = iv.stab(lg[mi], st[mi], en[mi], eg, eT, lr[mi]) / (n + fe.CP_SHRINK)
    wins = iv.stab(lg[mi], st[mi], en[mi], eg, eT, (v[mi] > 0).astype(np.float64))
    out["cp_win_7d"] = np.where(n > 0, wins / np.maximum(n, 1), np.nan)
    for k, name in ((KIND_PS, "ps_r_7d"), (KIND_DD, "dd_rate_7d")):
        sel = (kind == k) & np.isfinite(v)
        cnt = iv.stab(lg[sel], st[sel], en[sel], eg, eT)
        tot = iv.stab(lg[sel], st[sel], en[sel], eg, eT, v[sel])
        out[name] = np.where(cnt > 0, tot / np.maximum(cnt, 1), np.nan)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Stage 4: creators, token_info, hourly active wallets


def creator_stage(eps: pd.DataFrame, mints: pd.DataFrame, token_info: pd.DataFrame, lag: int = DECISION_LAG_SEC) -> pd.DataFrame:
    """
    eps: (episode_id, mint, T); mints: (mint, S, fts) over ALL buckets; token_info: (mint, creator, pool_created_at,
    launch_checked_at) with times as epoch seconds (float, NaN when null). cr_seen_prior_7d and log_token_age.
    """
    ti = token_info.drop_duplicates("mint").set_index("mint")
    mt = mints.set_index("mint")
    cre = ti["creator"].where(ti["creator"].astype(object).map(lambda c: isinstance(c, str) and c != ""), None)
    items = mt.join(cre, how="inner").dropna(subset=["creator"])
    codes, _ = pd.factorize(pd.concat([items["creator"], cre.reindex(eps["mint"]).reset_index(drop=True)], ignore_index=True))
    ig, qg = codes[: len(items)].astype(np.int64), codes[len(items):].astype(np.int64)
    s_i, e_i = _i64(items["S"]) - lag, _i64(items["fts"]) + W7 - lag
    eT = _i64(eps["T"])
    em = eps["mint"].to_numpy()
    S_e = mt["S"].reindex(em).to_numpy(dtype=np.float64)
    f_e = mt["fts"].reindex(em).to_numpy(dtype=np.float64)
    known = (qg >= 0) & np.isfinite(S_e) & (S_e < eT + lag)
    cnt = iv.stab(ig, s_i, e_i, np.where(qg >= 0, qg, 0), eT)
    own = (S_e - lag < eT) & (eT <= f_e + W7 - lag)
    out = pd.DataFrame({"episode_id": eps["episode_id"].to_numpy()})
    out["cr_seen_prior_7d"] = np.where(known, cnt - own, np.nan)
    pca = ti["pool_created_at"].reindex(em).to_numpy(dtype=np.float64)
    lca = ti["launch_checked_at"].reindex(em).to_numpy(dtype=np.float64)
    with np.errstate(invalid="ignore"):
        out["log_token_age"] = np.where(np.isfinite(pca) & np.isfinite(lca) & (lca < eT + lag), np.log1p(np.maximum(0.0, eT - pca)), np.nan)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Stage 5: one chunk of episodes -> the raw feature rows


def active_hours(counts: pd.Series, hours, outage=()) -> pd.Series:
    """
    The hourly table tracked_active_wallets_1h reads: tracked wallets delivered per hour (`counts` by hour start) over
    `hours`, NaN where no server process saw the whole hour (features.yaml: then the feature is missing, never 0):
    nothing delivered in it, an ingest outage derive masks (`outage`: hour starts, without the export-tail hours, where
    the stream ran and only the export came too early), or a dip below DIP_SHARE of both neighbouring hours (an outage
    inside the hour: 10-29 16:00 delivered 36 wallets between 5,574 and 5,344).
    """
    n = counts.astype(np.float64).reindex(np.asarray(hours, dtype=np.int64)).fillna(0.0)
    dip = (n < DIP_SHARE * n.shift(1)) & (n < DIP_SHARE * n.shift(-1))
    out = n.where((n > 0) & ~n.index.isin(np.asarray(list(outage), dtype=np.int64)) & ~dip)
    out.index.name = "h"
    return out


def active_wallets_at(t, hourly: pd.Series) -> np.ndarray:
    """
    tracked_active_wallets_1h at decision times t (epoch s): the count of the previous complete UTC hour (active_hours);
    missing (NaN) for an hour no server process saw: NaN or 0 in the table, or outside it.
    """
    prev = _i64(t) // 3_600 * 3_600 - 3_600
    v = hourly.reindex(prev).to_numpy(dtype=np.float64) if len(hourly) else np.full(len(prev), np.nan)
    return np.where(v > 0, v, np.nan)


def swap_features(base: pd.DataFrame, hourly: pd.Series, lag: int = DECISION_LAG_SEC) -> pd.DataFrame:
    """
    The fields of the incoming swap, the clock, the regime and social constants, and the gate, for a frame with
    T, leader_sol, leader_price_sol, venue, fee_lamports, mint and the coin features (mint_first_seen_age_min).
    hourly: tracked active wallets by hour start (epoch s), NaN for an hour no process saw (active_hours).
    """
    T = _i64(base["T"])
    t = T + lag
    out = pd.DataFrame(index=base.index)
    fee = base["fee_lamports"].to_numpy(dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        out["log_fee"] = np.where(fee >= 0, np.log1p(np.maximum(fee, 0)), np.nan)
        price = base["leader_price_sol"].to_numpy(dtype=np.float64)
        out["log_mcap_sol"] = np.where(price > 0, np.log10(price * 1e9), np.nan)
    venues = [None if v is None or (isinstance(v, float) and math.isnan(v)) else str(v) for v in base["venue"].tolist()]
    vs = {v: fe.strip_venue(v) for v in set(venues)}
    vg = {v: fe.venue_group(v) for v in vs}
    out["venue_group"] = np.array([vg[v] for v in venues], dtype=object)
    out["venue_via_bot"] = np.array([1.0 if vs[v][1] else 0.0 for v in venues], dtype=np.float64)
    out["sfx_pump"] = base["mint"].astype(str).str.endswith("pump").to_numpy(dtype=np.float64)
    out["signal_lateness_sec"] = float(lag)
    hour = (t % DAY) / 3_600.0
    out["hour_sin"] = np.sin(2 * math.pi * hour / 24)
    out["hour_cos"] = np.cos(2 * math.pi * hour / 24)
    out["tracked_active_wallets_1h"] = active_wallets_at(t, hourly)
    out["social_score"] = 0.0
    out["social_missing"] = 1.0

    stripped = [vs[v][0] for v in venues]
    sol = base["leader_sol"].to_numpy(dtype=np.float64)
    age = base["mint_first_seen_age_min"].to_numpy(dtype=np.float64)
    pumpswap = np.array([v is not None and v.startswith("pumpswap") for v in stripped], dtype=bool)
    amm = np.array([v in fe.YOUNG_AMM_VENUES for v in stripped], dtype=bool)
    gate = np.full(len(base), None, dtype=object)
    for name, fired in (
        ("screen_dead", np.zeros(len(base), dtype=bool)),  # no historical screens
        ("young_amm", amm & ~(age >= fe.YOUNG_AMM_MIN)),
        ("pumpswap_hiprice", pumpswap & (price >= fe.HIPRICE_SOL)),
        ("too_late", np.full(len(base), lag > fe.MAX_COPY_DELAY_SEC)),
        ("below_min_leader_buy", ~(sol >= fe.MIN_LEADER_BUY_SOL)),
    ):  # in reverse order: the first gate in spec order wins
        gate[fired] = name
    out["gate"] = gate
    return out


FEATURE_COLUMNS = [f.name for f in spec.entry_features()]
META_COLUMNS = ["episode_id", "leader", "mint", "ts", "period", "known_at_t", "crosses_outage", "ins_lag_sec", "stored_late",
                "leader_sol", "gate"]


def assemble(base: pd.DataFrame, hourly: pd.Series, lag: int = DECISION_LAG_SEC) -> pd.DataFrame:
    """base = episodes columns + the stage outputs joined on episode_id -> the features_entry rows."""
    sf = swap_features(base, hourly, lag)
    out = pd.concat([base, sf], axis=1)
    out["ins_lag_sec"] = (_i64(out["ins_t"]) - _i64(out["T"])).astype(np.float64)
    out["stored_late"] = out["ins_lag_sec"] > fe.MAX_COPY_DELAY_SEC
    for c in ("cp_lrshr_7d", "cp_n_7d", "b_n_24h", "leader_n_prior7", "m_buyers_5m", "m_buysol_5m", "leader_sold_at_decision"):
        out[c] = out[c].fillna(0.0)  # counts: an episode with no rows anywhere is 0, never missing
    for c in ("leader", "mint", "period", "gate", "venue_group"):  # a chunk where no gate fires still writes strings
        out[c] = out[c].astype("string")
    return out[META_COLUMNS + FEATURE_COLUMNS]


# ---------------------------------------------------------------------------------------------------------------------
# The full build


def _write(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("_" + path.name)
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), tmp, compression="zstd")
    tmp.rename(path)


def _rm(p: Path) -> None:
    derive.rmtree(p)


def _read(con: duckdb.DuckDBPyConnection, d: Path, cols: str = "*", where: str = "") -> pd.DataFrame:
    if not has_parquet(d):
        return pd.DataFrame()
    w = f"WHERE {where}" if where else ""
    return con.execute(f"SELECT {cols} FROM read_parquet({sql_str(parquet_glob(d))}, union_by_name=true) {w}").df()


def build(root: Path | None = None, n_buckets: int = N_MINT_BUCKETS, n_leader: int = N_LEADER_BUCKETS, only: list[int] | None = None,
          resume: bool = False, memory_limit: str = "1200MB", threads: int = 2, force: bool = False) -> dict:
    root = root or data_dir()
    t0 = time.time()
    lag = DECISION_LAG_SEC
    dd = derived_dir(root)
    if not (dd / "episodes.parquet").is_file() or not (dd / "ins_steps.parquet").is_file():
        raise SystemExit("derived/episodes.parquet and ins_steps.parquet are needed: run python -m brain.data.derive first")
    if any(dd.glob("_build_*")) and not force:
        raise SystemExit(f"a derive build is staging in {dd} (derived/_build_*): wait for it, or pass --force if it is abandoned")
    stage = root / "tmp" / "features_build"
    if not resume:
        _rm(stage)
    stage.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    configure(con, memory_limit, threads, root / "tmp" / "duckdb_features")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ins_steps AS SELECT * FROM read_parquet({sql_str(dd / 'ins_steps.parquet')})")
    sources = swap_sources(root)
    timing: dict[str, float] = {}

    # ---- 1. split swaps and episodes into mint buckets
    ts = time.time()
    if not (stage / "swaps" / "_split_done").is_file():
        log(f"splitting swaps into {n_buckets} mint buckets")
        _rm(stage / "swaps")
        derive.split_swaps(con, sources, stage / "swaps", n_buckets)
        (stage / "swaps" / "_split_done").write_text("ok")
    if not (stage / "eps" / "_split_done").is_file():
        log("splitting episodes")
        _rm(stage / "eps")
        # a few buckets per pass, like derive.split_swaps: one PARTITION_BY over all 64 spills under the memory limit
        # and crawls on the USB drive
        for lo in range(0, n_buckets, EPS_PER_PASS):
            hi = min(n_buckets, lo + EPS_PER_PASS)
            con.execute(f"""
                COPY (SELECT * FROM (SELECT episode_id, leader, mint, epoch(ts)::BIGINT AS T, leader_sol, leader_pos_tokens,
                                            (hash(mint) % {n_buckets})::INT AS bucket
                                     FROM read_parquet({sql_str(dd / 'episodes.parquet')}))
                      WHERE bucket >= {lo} AND bucket < {hi})
                TO {sql_str(stage / 'eps')} (FORMAT parquet, PARTITION_BY (bucket), COMPRESSION zstd, OVERWRITE_OR_IGNORE true)
            """)
            log(f"  episode buckets {lo}..{hi - 1}")
        (stage / "eps" / "_split_done").write_text("ok")
    timing["split_s"] = round(time.time() - ts)
    wg = parquet_glob(export_dir(root) / "wallets")
    con.execute(f"CREATE OR REPLACE TEMP TABLE pool AS SELECT DISTINCT address FROM read_parquet({sql_str(wg)}, union_by_name=true) WHERE address IS NOT NULL")
    pool = set(con.execute("SELECT address FROM pool").df()["address"])

    # ---- 2. mint buckets
    ts = time.time()
    buckets = only if only is not None else list(range(n_buckets))
    counts = {"swaps": 0, "episodes": 0, "mirror_rows": 0, "ps_rows": 0, "dd_rows": 0}
    for k in buckets:
        done = stage / "_done" / f"m{k:02d}.json"
        if done.is_file():
            for key, v in json.loads(done.read_text()).items():
                counts[key] += v
            continue
        tb = time.time()
        bdir = stage / "swaps" / f"bucket={k}"
        edir = stage / "eps" / f"bucket={k}"
        if not has_parquet(bdir) or not has_parquet(edir):
            done.parent.mkdir(parents=True, exist_ok=True)
            done.write_text(json.dumps({key: 0 for key in counts}))
            continue
        derive.prepare_swaps(con, f"SELECT * EXCLUDE (bucket) FROM read_parquet({sql_str(parquet_glob(bdir))})", "ins_steps")
        sw = bucket_swaps(con)
        con.execute("DROP TABLE IF EXISTS sw")
        eps = _read(con, edir, "episode_id, leader, mint, T, leader_sol, leader_pos_tokens")
        feats, mint_tab, ledger = mint_stage(sw, eps[["episode_id", "leader_pos_tokens"]], lag)
        feats["day"] = utc_day(eps["T"])
        _write(feats.sort_values("day", kind="stable"), stage / "mint_feats" / f"b{k:02d}.parquet")
        _write(mint_tab, stage / "mints" / f"b{k:02d}.parquet")
        _write(hourly_pairs(sw), stage / "hourly" / f"b{k:02d}.parquet")
        sw["lb"] = leader_bucket(sw["wallet"], n_leader)
        lsw = sw[sw["wallet"].isin(pool)]
        ledger["lb"] = leader_bucket(ledger["leader"], n_leader)
        eps["lb"] = leader_bucket(eps["leader"], n_leader)
        for j in range(n_leader):
            _write(lsw.loc[lsw["lb"] == j, ["wallet", "mint", "side", "t", "a", "sol"]], stage / "lsw" / f"lb={j}" / f"b{k:02d}.parquet")
            _write(ledger.loc[ledger["lb"] == j, ["kind", "leader", "at", "v", "lr"]], stage / "ledger" / f"lb={j}" / f"b{k:02d}.parquet")
            _write(eps.loc[eps["lb"] == j, ["episode_id", "leader", "T", "leader_sol"]].rename(columns={"leader_sol": "sol"}),
                   stage / "leps" / f"lb={j}" / f"b{k:02d}.parquet")
        c = {"swaps": len(sw), "episodes": len(eps), "mirror_rows": int((ledger["kind"] == KIND_MIRROR).sum()),
             "ps_rows": int((ledger["kind"] == KIND_PS).sum()), "dd_rows": int((ledger["kind"] == KIND_DD).sum())}
        done.parent.mkdir(parents=True, exist_ok=True)
        done.write_text(json.dumps(c))
        for key in counts:
            counts[key] += c[key]
        log(f"mint bucket {k:02d}: {c} in {time.time() - tb:.0f}s")
        del sw, lsw, eps, feats, ledger
    timing["mint_buckets_s"] = round(time.time() - ts)

    # ---- 3. leader buckets (a partial build keeps its own: they only see the buckets it built)
    ts = time.time()
    own = stage / "_partial" if only is not None else stage
    _rm(stage / "_partial")
    for j in range(n_leader):
        out = own / "leader_feats" / f"l{j:02d}.parquet"
        if out.is_file():
            continue
        tb = time.time()
        lsw = _read(con, stage / "lsw" / f"lb={j}")
        leps = _read(con, stage / "leps" / f"lb={j}")
        led = _read(con, stage / "ledger" / f"lb={j}")
        if leps.empty:
            continue
        if led.empty:
            led = pd.DataFrame({"kind": pd.Series(dtype=np.int8), "leader": pd.Series(dtype=object), "at": pd.Series(dtype=np.int64),
                                "v": pd.Series(dtype=np.float64), "lr": pd.Series(dtype=np.float64)})
        lf = leader_stage(lsw, leps, led, lag)
        lf["day"] = utc_day(leps["T"])
        _write(lf.sort_values("day", kind="stable"), out)
        log(f"leader bucket {j:02d}: {len(leps)} episodes, {len(lsw)} swaps, {len(led)} ledger rows in {time.time() - tb:.0f}s")
        del lsw, leps, led, lf
    timing["leader_buckets_s"] = round(time.time() - ts)

    # ---- 4. creators / token_info; hourly active wallets
    ts = time.time()
    mints = _read(con, stage / "mints")
    ti_cols = present_columns(parquet_glob(export_dir(root) / "token_info"))
    tcol = lambda c: f"epoch(TRY_CAST({c} AS TIMESTAMPTZ))" if c in ti_cols else "NULL::DOUBLE"  # noqa: E731
    token_info = con.execute(f"""
        SELECT mint, {'creator' if 'creator' in ti_cols else 'NULL::VARCHAR'} AS creator, {tcol('pool_created_at')} AS pool_created_at,
               {tcol('launch_checked_at')} AS launch_checked_at
        FROM read_parquet({sql_str(parquet_glob(export_dir(root) / 'token_info'))}, union_by_name=true)
    """).df()
    for k in buckets:
        out = own / "creator_feats" / f"b{k:02d}.parquet"
        if out.is_file() or not has_parquet(stage / "eps" / f"bucket={k}"):
            continue
        eps = _read(con, stage / "eps" / f"bucket={k}", "episode_id, mint, T")
        cf = creator_stage(eps, mints, token_info, lag)
        cf["day"] = utc_day(eps["T"])
        _write(cf.sort_values("day", kind="stable"), out)
    hourly = con.execute(f"SELECT h, count(DISTINCT wallet) AS n FROM read_parquet({sql_str(parquet_glob(stage / 'hourly'))}) GROUP BY h").df()
    data_h = con.execute(f"SELECT min(epoch(ts))::BIGINT // 3600 * 3600, max(epoch(ts))::BIGINT // 3600 * 3600 FROM read_parquet({sql_str(dd / 'episodes.parquet')})").fetchone()
    outage = []
    if (dd / "outage_hours.parquet").is_file():
        outage = [r[0] for r in con.execute(f"SELECT h FROM read_parquet({sql_str(dd / 'outage_hours.parquet')}) WHERE NOT export_tail").fetchall()]
    hourly = active_hours(hourly.set_index("h")["n"], np.arange(data_h[0] - 3_600, data_h[1] + 1, 3_600), outage)
    log(f"hourly active wallets: {int(hourly.notna().sum())} of {len(hourly)} hours seen ({len(outage)} ingest-outage hours masked)")
    timing["creators_hourly_s"] = round(time.time() - ts)

    # ---- 5. assemble per day
    ts = time.time()
    final = dd / "_features_entry_build"
    _rm(final)
    ep_glob = sql_str(dd / "episodes.parquet")
    days = [r[0] for r in con.execute(f"SELECT DISTINCT day FROM read_parquet({ep_glob}) ORDER BY 1").fetchall()]
    mf = sql_str(parquet_glob(stage / "mint_feats"))
    lfp, cfp = (sql_str(parquet_glob(own / d)) for d in ("leader_feats", "creator_feats"))
    where_b = f"AND (hash(mint) % {n_buckets}) IN ({','.join(map(str, buckets))})" if only is not None else ""
    n_rows = 0
    for d in days:
        dn = (pd.Timestamp(d) - pd.Timestamp("1970-01-01")).days
        n_day = con.execute(f"SELECT count(*) FROM read_parquet({ep_glob}) WHERE day = DATE '{d}' {where_b}").fetchone()[0]
        parts = max(1, -(-n_day // CHUNK_ROWS))
        for p in range(parts):
            base = con.execute(f"""
                SELECT e.episode_id, e.leader, e.mint, e.ts, epoch(e.ts)::BIGINT AS T, epoch(e.ins_ts)::BIGINT AS ins_t, e.period,
                       e.known_at_t, e.crosses_outage, e.leader_sol, e.leader_price_sol, e.venue, e.fee_lamports,
                       m.* EXCLUDE (episode_id, day), l.* EXCLUDE (episode_id, day), c.* EXCLUDE (episode_id, day)
                FROM (SELECT * FROM read_parquet({ep_glob}) WHERE day = DATE '{d}' {where_b} AND episode_id % {parts} = {p}) e
                LEFT JOIN (SELECT * FROM read_parquet({mf}) WHERE day = {dn}) m USING (episode_id)
                LEFT JOIN (SELECT * FROM read_parquet({lfp}) WHERE day = {dn}) l USING (episode_id)
                LEFT JOIN (SELECT * FROM read_parquet({cfp}) WHERE day = {dn}) c USING (episode_id)
            """).df()
            rows = assemble(base, hourly, lag)
            if len(rows):  # an empty chunk (a partial build) would write untyped columns
                _write(rows, final / f"day={d}" / f"part-{p:02d}.parquet")
            n_rows += len(rows)
        log(f"day {d}: {n_day} episodes")
    timing["assemble_s"] = round(time.time() - ts)

    # ---- levels and norm from FIT training rows; counts
    ts = time.time()
    meta = fit_meta(con, final)
    meta.update({
        "built_at": datetime.now(timezone.utc).isoformat(), "feature_spec_version": spec.version(),
        "decision_lag_sec": lag, "n_mint_buckets": n_buckets, "only_buckets": only, "rows": n_rows,
        "ledger_rows": counts, "train_where": TRAIN_WHERE, "splits": splits.load(),
    })
    timing["norm_s"] = round(time.time() - ts)
    timing["total_s"] = round(time.time() - t0)
    meta["timing"] = timing
    con.close()
    target = dd / (OUT_NAME if only is None else f"_partial_{OUT_NAME}")
    meta_path = dd / (META_NAME if only is None else f"_partial_{META_NAME}")
    _rm(target)
    final.rename(target)
    meta_path.write_text(json.dumps(meta, indent=1, default=str))
    if only is None:
        _write(hourly.rename("n").reset_index(), dd / HOURLY_NAME)
    if only is None and not resume:
        _rm(stage)
    log(f"done in {timing['total_s']}s: {n_rows} rows; gate pass {meta['gates']['pass_rate']:.3f}")
    return meta


def fit_meta(con: duckdb.DuckDBPyConnection, out_dir: Path) -> dict:
    """venue_group levels and the norm from FIT training rows, plus gate counts and pass rates."""
    g = sql_str(str(out_dir / "*" / "[!.]*.parquet"))
    src = f"read_parquet({g}, hive_partitioning=true)"
    vg = con.execute(f"SELECT venue_group, count(*) n FROM {src} WHERE {TRAIN_WHERE} GROUP BY 1").df()
    cats = {"venue_group": spec.fit_levels(dict(zip(vg["venue_group"], vg["n"])))}
    feats = spec.entry_features()
    cols = spec.columns(feats, cats)
    acc = spec.NormAccumulator(cols, spec.binary_columns(feats, cats))
    reader = con.sql(f"SELECT {', '.join(FEATURE_COLUMNS)} FROM {src} WHERE {TRAIN_WHERE}").to_arrow_reader(200_000)
    n_train = 0
    for batch in reader:
        df = batch.to_pandas()
        n_train += len(df)
        acc.add(spec.encode(df, feats, cats))
    norm = acc.norm()
    gates = con.execute(f"SELECT coalesce(gate, 'pass') g, count(*) n FROM {src} GROUP BY 1 ORDER BY 2 DESC").df()
    by_period = con.execute(f"""
        SELECT period, count(*) n, avg((gate IS NULL)::INT) pass_rate,
               avg((gate IS NULL)::INT) FILTER (WHERE known_at_t AND NOT crosses_outage) pass_rate_known,
               avg(stored_late::INT) stored_late,
               avg((gate IS NULL AND NOT stored_late)::INT) pass_and_live
        FROM {src} GROUP BY 1 ORDER BY 1
    """).df()
    total = int(gates["n"].sum())
    passed = int(gates.loc[gates["g"] == "pass", "n"].sum())
    return {
        "features": FEATURE_COLUMNS, "columns": cols, "categories": cats, "norm": norm.to_json(), "n_train_rows": n_train,
        "gates": {"counts": dict(zip(gates["g"], gates["n"].astype(int))), "pass_rate": passed / max(total, 1),
                  "by_period": by_period.to_dict(orient="records")},
    }


# ---------------------------------------------------------------------------------------------------------------------
# Reading a build


def load_meta(root: Path | None = None) -> dict:
    return json.loads((derived_dir(root) / META_NAME).read_text())


def load_hourly(root: Path | None = None) -> pd.Series:
    """derived/active_wallets_hourly.parquet as a Series n by hour start (epoch s), for active_wallets_at."""
    df = pd.read_parquet(derived_dir(root) / HOURLY_NAME)
    return df.set_index("h")["n"].astype(np.float64).sort_index()


def load_entry(where: str = TRAIN_WHERE, columns: list[str] | None = None, root: Path | None = None,
               con: duckdb.DuckDBPyConnection | None = None) -> pd.DataFrame:
    """Rows of derived/features_entry (raw values) matching `where` (SQL on its columns, e.g. period / gate / day)."""
    own = con is None
    if own:
        con = duckdb.connect()
        configure(con, temp_dir=(root or data_dir()) / "tmp" / "duckdb_features")
    g = sql_str(str(derived_dir(root) / OUT_NAME / "*" / "[!.]*.parquet"))
    cols = ", ".join(columns) if columns else "*"
    try:
        return con.execute(f"SELECT {cols} FROM read_parquet({g}, hive_partitioning=true) WHERE {where}").df()
    finally:
        if own:
            con.close()


def matrix(frame: pd.DataFrame, meta: dict | None = None) -> np.ndarray:
    """The normalised entry matrix (float32, meta['columns'] order) of raw features_entry rows."""
    meta = meta or load_meta()
    X = spec.encode(frame, spec.entry_features(), meta["categories"])
    return spec.normalise(X, spec.Norm.from_json(meta["norm"])).astype(np.float32)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--buckets", type=int, default=N_MINT_BUCKETS, help="number of mint-hash buckets")
    ap.add_argument("--leader-buckets", type=int, default=N_LEADER_BUCKETS)
    ap.add_argument("--only", type=str, default="", help="comma-separated mint buckets: a partial build into derived/_partial_*")
    ap.add_argument("--resume", action="store_true", help="keep the staging of an interrupted build and continue")
    ap.add_argument("--root", type=str, default="", help="data dir (default brain.config.DATA_DIR)")
    ap.add_argument("--force", action="store_true", help="run although derived/_build_* exists (an abandoned derive build)")
    a = ap.parse_args(argv)
    only = [int(x) for x in a.only.split(",") if x.strip()] or None
    build(Path(a.root) if a.root else None, a.buckets, a.leader_buckets, only, a.resume, force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
