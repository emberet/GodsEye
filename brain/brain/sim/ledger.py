"""
The mirror ledger (features.yaml cp_lrshr_7d / cp_n_7d / cp_win_7d): what a strict late copier got on each copy-eligible
leader buy, and when it became knowable. The spec implementation, which the brain's entry features come from, is
brain/features/build.py ledger_rows; this one follows the same rules on the simulator's SwapTape (tests/test_sim_ledger.py
checks it row by row against ledger_rows) and is the research cross-check. B4's veto reads the features_entry values
(brain.baselines entry_cp), never this file, so the bar vetoes on exactly the number the brain sees.

    python -m brain.sim.ledger                 # all days -> <DATA>/sim/ledger_mirror.parquet (~30 min on the drive)
    led = load_ledger()
    cp = cp_features(led, sig["leader"], sig["t_dec"])   # cp_n_7d, cp_lrshr_7d, cp_win_7d at each decision time

Row y per copy-eligible (>= 0.2 SOL) leader buy of derived/episodes (every one, known or not, as build.py: features.yaml
python_source), strict timing on the ok tape (the features.yaml ok flag: token floor, trailing median, lone rule;
tape.trailing_ok with env=False, warmed up on the mint's last 10 valid prints of the previous 7 days):
  entry  first ok print by a wallet other than the leader in [ts + 15 s, ts + 135 s] (none: no row)
  stop   the first ok print after the entry's second and before ts + 24 h at or below -60 % of the entry: fills there (gap)
  exit   the leader sold within 24 h: the first ok SELL by a non-leader at or after max(first leader sell + 15 s,
         entry + 1 s), before ts + 24 h; the stop wins when it comes first
  held   neither before ts + 24 h: the first ok print at or after ts + 24 h if it comes by ts + 30 h (grounded), else
         dead: y = -1 (no haircut)
  y      exit / entry - 1 - 0.026 (fixed cost haircut), capped at +20
  resolved_at  when the server could know y (features.yaml python_source): the latest INSERT time of the buy (episodes
         ins_ts), the entry print, the leader's first sell (when it set the exit) and the deciding print; dead rows
         max(buy + 30 h, those). Most swaps were stored minutes to days after their ts, so a ts-based time leaks.
Rows not resolved by the data end (evaluate.data_end_ts: the label end, where the export tail starts) are left out.
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from brain.data import connect
from brain.data.derive import TRAIL_WINDOW
from brain.data.loaders import data_dir
from brain.sim.evaluate import data_end_ts
from brain.sim.signals import leader_sells, load_signals
from brain.sim.tape import SwapTape, key, outage_ms, tape_frame, to_ms

OUT = "sim/ledger_mirror.parquet"
HAIRCUT = 0.026
ENTRY_FROM_MS, ENTRY_TO_MS = 15_000, 135_000
EXIT_AFTER_MS = 15_000
HOLD_MS = 86_400_000
LOOK_MS = 21_600_000
STOP = 0.4  # -60 %
Y_CAP = 20.0
SHRINK_N = 20
WINDOW_MS = 7 * 86_400_000
WARM = pd.Timedelta(days=7)  # the ok filter's warm-up: the mint's last TRAIL_WINDOW valid prints this far back


def _next_run(mint: np.ndarray, wallet: np.ndarray) -> np.ndarray:
    """For each row of rows sorted by (mint, time): the index of the start of the next (mint, wallet) run (len at the end)."""
    n = len(mint)
    if not n:
        return np.zeros(0, dtype=np.int64)
    run = np.r_[True, (mint[1:] != mint[:-1]) | (wallet[1:] != wallet[:-1])]
    starts = np.r_[np.flatnonzero(run), n]
    return starts[np.cumsum(run)]  # run id + 1


def _first_by_other(keys: np.ndarray, mint: np.ndarray, wallet: np.ndarray, nxt: np.ndarray, m: np.ndarray, t: np.ndarray,
                    leader: np.ndarray) -> np.ndarray:
    """Index of the first row of mint m with time >= t by a wallet other than `leader` (rows sorted by key), -1 if none."""
    n = len(keys)
    if not n:
        return np.full(len(m), -1, dtype=np.int64)
    c = np.searchsorted(keys, key(m, t), "left")
    cc = np.minimum(c, n - 1)
    c = np.where((c < n) & (mint[cc] == m) & (wallet[cc] == leader), nxt[cc], c)  # skip the leader's run: the next is another wallet's
    cc = np.minimum(c, n - 1)
    return np.where((c < n) & (mint[cc] == m), c, -1)


def _first_at_or_below(tape: SwapTape, start: np.ndarray, mint: np.ndarray, t_end: np.ndarray, level: np.ndarray,
                       block: int = 128) -> np.ndarray:
    """First ok index >= start of `mint` with t <= t_end and price <= level, -1 if none (block-wise forward scan)."""
    n = len(tape.ok_t)
    res = np.full(len(start), -1, dtype=np.int64)
    cur = start.copy()
    todo = (cur >= 0) & (cur < n)
    m0 = np.asarray(mint, dtype=np.int64)
    while todo.any():
        q = np.flatnonzero(todo)
        cols = cur[q][:, None] + np.arange(block)[None, :]
        inb = cols < n
        cc = np.clip(cols, 0, n - 1)
        valid = inb & (tape.ok_mint[cc] == m0[q][:, None]) & (tape.ok_t[cc] <= t_end[q][:, None])
        hit = valid & (tape.ok_price[cc] <= level[q][:, None])
        anyhit = hit.any(axis=1)
        first = np.argmax(hit, axis=1)
        res[q[anyhit]] = cur[q[anyhit]] + first[anyhit]
        # stop when hit, or when the block ran past the range
        cont = ~anyhit & valid.all(axis=1)
        todo[q] = cont
        cur[q[cont]] += block
    return res


GROUP_SIGNALS = 300_000  # signals per tape load: bounds memory on the busiest days (10-27..10-30)


def mirror_day(con, day: pd.Timestamp, data_end_ms: int) -> pd.DataFrame:
    """Ledger rows for the copy-eligible leader buys of one UTC day (in mint groups on busy days)."""
    sig = load_signals(con, day, day + pd.Timedelta(days=1), known=False, no_outage=False)
    if sig.empty:
        return pd.DataFrame()
    k = max(1, -(-len(sig) // GROUP_SIGNALS))
    grp = pd.util.hash_array(sig["mint"].to_numpy(dtype=object)) % k
    parts = [mirror_signals(con, sig[grp == g].reset_index(drop=True), day, data_end_ms) for g in range(k)]
    return pd.concat(parts, ignore_index=True)


def mirror_signals(con, sig: pd.DataFrame, day: pd.Timestamp, data_end_ms: int) -> pd.DataFrame:
    end = day + pd.Timedelta(hours=55)  # the day's buys + 24 h hold + 6 h grounded lookahead + an entry window
    df = tape_frame(con, sig["mint"].unique(), day, end, warm=TRAIL_WINDOW, warm_from=day - WARM)
    tape = SwapTape.from_frame(df, env_filter=False, data_end=min(data_end_ms, int(to_ms([end])[0])), outage_h=outage_ms(con),
                               insert_index=False)  # features.yaml cp_* use the spec's ok flag, not the environment's
    del df
    return mirror(sig, tape, data_end_ms)


def mirror(sig: pd.DataFrame, tape: SwapTape, data_end_ms: int) -> pd.DataFrame:
    """The ledger rows of `sig` (signals.prepare columns) on `tape` (build.py ledger_rows rules)."""
    m = tape.codes(sig["mint"])
    ld = tape.wcodes(sig["leader"])
    ts = sig["t_ms"].to_numpy()
    end = ts + HOLD_MS  # stops and leader-follow exits count before buy + 24 h
    ins = lambda k: tape.ins[tape.okr[k]]  # noqa: E731 - insert time of ok rows
    ok_w = tape.wallet[tape.okr].astype(np.int64)
    # entry
    e = _first_by_other(tape.ok_key, tape.ok_mint, ok_w, _next_run(tape.ok_mint, ok_w), m, ts + ENTRY_FROM_MS, ld)
    ec = np.clip(e, 0, None)
    has_e = (e >= 0) & (tape.ok_t[ec] <= ts + ENTRY_TO_MS)
    et, ep = tape.ok_t[ec], tape.ok_price[ec]
    known = np.maximum(sig["ins_ms"].to_numpy(np.int64), ins(ec))  # the buy and the entry print reached the server
    # the leader's first sell within 24 h
    ls = leader_sells(sig, tape, horizon_ms=HOLD_MS)
    cnt = np.diff(ls["off"])
    first = np.clip(ls["off"][:-1], 0, max(len(ls["t"]) - 1, 0))
    fs = np.where(cnt > 0, ls["t"][first] if len(ls["t"]) else 0, -1)
    fs_ins = np.where(cnt > 0, ls["ins"][first] if len(ls["t"]) else 0, -1)
    sold = fs >= 0
    # stop: after the entry's second, before buy + 24 h
    s0 = np.where(has_e, tape.next_ok(m, et), -1)
    st_i = _first_at_or_below(tape, s0, m, end - 1, ep * STOP)
    # leader-follow exit: the first ok non-leader SELL at/after max(leader sell + 15 s, entry + 1 s), before buy + 24 h
    si = np.flatnonzero(tape.ok_side < 0)
    sm, sw = tape.ok_mint[si], ok_w[si]
    x = np.maximum(fs + EXIT_AFTER_MS, et + 1000)
    c = _first_by_other(tape.ok_key[si], sm, sw, _next_run(sm, sw), m, x, ld)
    xi = np.where(c >= 0, si[np.clip(c, 0, None)] if len(si) else -1, -1)
    xc = np.clip(xi, 0, None)
    got_x = has_e & sold & (xi >= 0) & (tape.ok_t[xc] < end)
    stopped = has_e & (st_i >= 0) & (~got_x | (st_i <= xi))
    follow = got_x & ~stopped
    # held 24 h: grounded value (the first ok print at or after buy + 24 h, by buy + 30 h), else dead
    b = has_e & ~stopped & ~follow
    gi = tape.next_ok(m, end, strict=False)
    gc = np.clip(gi, 0, None)
    held = b & (gi >= 0) & (tape.ok_t[gc] <= end + LOOK_MS)
    dead = b & ~held
    d = np.where(stopped, st_i, np.where(follow, xi, gi))
    dc = np.clip(d, 0, None)
    with np.errstate(divide="ignore", invalid="ignore"):
        y = np.where(dead, -1.0, np.minimum(tape.ok_price[dc] / ep - 1 - HAIRCUT, Y_CAP))
    res = np.where(dead, np.maximum(known, end + LOOK_MS), np.maximum(known, ins(dc)))
    res = np.where(follow, np.maximum(res, fs_ins), res)
    keep = has_e & (res <= data_end_ms)
    out = pd.DataFrame({"episode_id": sig["episode_id"].to_numpy(), "leader": sig["leader"].to_numpy(), "mint": sig["mint"].to_numpy(),
                        "buy_ms": ts, "entry_ms": et, "y": y, "resolved_ms": res,
                        "how": np.select([stopped, follow, held], ["stop", "follow", "held"], "held_dark")})
    return out[keep].reset_index(drop=True)


def built_on() -> dict:
    """The derive build (derived/_meta.json built_at) and data end a ledger is made on: stamped into the parquet."""
    meta = json.loads((data_dir() / "derived" / "_meta.json").read_text())
    return {"derive_built_at": str(meta.get("built_at", "")), "data_end": str(data_end_ts(meta))}


def build(days=None, path=None) -> pd.DataFrame:
    con = connect()
    data_end_ms = int(to_ms([data_end_ts()])[0])
    if days is None:
        lo, hi = con.execute("SELECT min(day), max(day) FROM episodes").fetchone()
        days = pd.date_range(pd.Timestamp(lo, tz="UTC"), pd.Timestamp(hi, tz="UTC"), freq="D")
    parts = []
    for d in days:
        t = time.time()
        part = mirror_day(con, pd.Timestamp(d), data_end_ms)
        parts.append(part)
        print(f"{pd.Timestamp(d):%Y-%m-%d} rows {len(part):>9,} ({time.time() - t:.0f} s)", flush=True)
    led = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    path = path or data_dir() / OUT
    path.parent.mkdir(parents=True, exist_ok=True)
    tab = pa.Table.from_pandas(led, preserve_index=False)
    meta = {**(tab.schema.metadata or {}), b"brain_ledger": json.dumps(built_on()).encode()}
    pq.write_table(tab.replace_schema_metadata(meta), path)
    return led


def load_ledger(path=None) -> pd.DataFrame:
    return pd.read_parquet(path or data_dir() / OUT)


def ledger_meta(path=None) -> dict:
    """built_on() of a saved ledger ({} for one written before the stamp): compare with built_on() to spot a stale file."""
    md = pq.read_schema(path or data_dir() / OUT).metadata or {}
    return json.loads(md[b"brain_ledger"]) if b"brain_ledger" in md else {}


def cp_features(led: pd.DataFrame, leader, t_ms) -> pd.DataFrame:
    """cp_n_7d, cp_lrshr_7d (SUM ln(1 + clip(y, -0.99, 10)) / (n + 20)), cp_win_7d (NaN when n = 0) over rows resolved in [t - 7 d, t)."""
    leader = pd.Series(np.asarray(leader, dtype=object))
    t = np.asarray(t_ms, dtype=np.int64)
    codes = pd.Index(pd.unique(pd.concat([led["leader"], leader], ignore_index=True)))
    lc = codes.get_indexer(led["leader"]).astype(np.int64)
    o = np.lexsort((led["resolved_ms"].to_numpy(), lc))
    lk = (lc[o] << 42) | led["resolved_ms"].to_numpy(np.int64)[o]
    lr = np.log1p(np.clip(led["y"].to_numpy(np.float64)[o], -0.99, 10))
    win = (led["y"].to_numpy(np.float64)[o] > 0).astype(np.float64)
    c_lr, c_w = np.r_[0, np.cumsum(lr)], np.r_[0, np.cumsum(win)]
    q = codes.get_indexer(leader).astype(np.int64)
    a = np.searchsorted(lk, (q << 42) | np.maximum(t - WINDOW_MS, 0), "left")
    b = np.searchsorted(lk, (q << 42) | t, "left")
    n = (b - a).astype(np.float64)
    return pd.DataFrame({"cp_n_7d": n, "cp_lrshr_7d": (c_lr[b] - c_lr[a]) / (n + SHRINK_N),
                         "cp_win_7d": np.where(n > 0, (c_w[b] - c_w[a]) / np.maximum(n, 1), np.nan)})


if __name__ == "__main__":
    led = build()
    print(f"ledger rows {len(led):,}; how {led['how'].value_counts().to_dict()}; mean y {led['y'].mean():+.4f}")
