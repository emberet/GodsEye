"""
The signals the simulator replays (leader buys from derived/episodes) and the hard gates of features.yaml.

    sig = load_signals(con, "2026-10-31", "2026-11-02")           # copy-eligible, known_at_t, not crosses_outage
    tape = load_tape(con, sig.mint.unique(), start - 7 d, end + 31 h)
    sig = add_gates(sig, tape)                                     # lateness_s, t_dec, gate_* columns and `gate`
    sells = leader_sells(sig, tape)                                # the leader's later sells of each signal's mint (CSR)

Population (sim.yaml episodes): every leader buy >= 0.2 SOL (MIN_LEADER_BUY_SOL) by an analyzed wallet the server knew at
ts (known_at_t), whose 24 h valuation window does not touch an ingest outage (crosses_outage), all chunks (a re-buy of a
coin already held is blocked by the account's one-position-per-coin rule, not dropped here).

Gates (features.yaml gates, applied before any network; the baselines B1/B2 ignore all but too_late, which the real engine
applies to everyone):
  too_late           decision time - leader block time > 60 s (simulated decision lateness, + backlog chaos)
  pumpswap_hiprice   venue pumpswap and leader price >= 1e-4 SOL per UI token
  young_amm          AMM venue and the mint's first tracked swap before the decision is at most 10 min old (or there is
                     none). Block time, "as if live" (sim.yaml insert_time): a live stream has every earlier swap by then,
                     while by insert time most backfilled coins (selection and test days) had no sighting yet and the
                     gate fired on 50 % of them vs 20 % of on-time signals. A first sighting more than 7 d back is old
                     (mint_first_seen_age_min caps at 7 d, it is not missing); the tape starts 7 d before the window, so
                     "none" means none in that span
  screen_dead        not replayable (async rug screen; only 627 historical rows): not applied
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from brain.data.loaders import sql_str
from brain.sim.params import Chaos, SimParams, lognormal, uniform
from brain.sim.tape import SwapTape, T0_MS, to_ms

MIN_LEADER_SOL = 0.2
HIPRICE = 1e-4
YOUNG_AMM_VENUES = {"pumpswap", "meteora", "meteora dbc", "raydium", "raydium launchlab", "orca"}
YOUNG_MS = 600_000
GATES = ("too_late", "pumpswap_hiprice", "young_amm")

COLUMNS = ("episode_id, leader, mint, ts, slot, day, period, ins_ts, known_at_t, crosses_outage, leader_sol, leader_price_sol, "
           "leader_price_ok, venue, token_age_sec, fee_lamports, jito_tip, leader_tokens, leader_pos_tokens, "
           "leader_prior_buys_mint, mint_prior_swaps, leader_first_sell_sec, leader_first_sell_frac, censored_24h")


def load_signals(con, start, end, *, known: bool = True, no_outage: bool = True, min_sol: float = MIN_LEADER_SOL,
                 where: str = "") -> pd.DataFrame:
    """Leader buys with ts in [start, end) from the episodes view, sorted by ts (then id), with t_ms / ins_ms (ms since T0_MS)."""
    st, en = pd.Timestamp(start), pd.Timestamp(end)
    st = st.tz_localize("UTC") if st.tzinfo is None else st
    en = en.tz_localize("UTC") if en.tzinfo is None else en
    w = [f"ts >= TIMESTAMPTZ {sql_str(st.isoformat())}", f"ts < TIMESTAMPTZ {sql_str(en.isoformat())}", f"leader_sol >= {float(min_sol)}"]
    if known:
        w.append("known_at_t")
    if no_outage:
        w.append("NOT crosses_outage")
    if where:
        w.append(f"({where})")
    df = con.execute(f"SELECT {COLUMNS} FROM episodes WHERE {' AND '.join(w)} ORDER BY ts, episode_id").df()
    return prepare(df)


def prepare(df: pd.DataFrame) -> pd.DataFrame:
    df = df.reset_index(drop=True)
    df["t_ms"] = to_ms(df["ts"])
    df["ins_ms"] = to_ms(df["ins_ts"].fillna(df["ts"])) if "ins_ts" in df else df["t_ms"]
    df["day"] = pd.to_datetime(df["ts"], utc=True).dt.strftime("%Y-%m-%d")
    v = df["venue"].fillna("").astype(str).str.replace(" (via bot)", "", regex=False).str.lower()
    df["venue_clean"] = v
    return df


def lateness(sig: pd.DataFrame, p: SimParams = SimParams(), chaos: Chaos = Chaos(), seed: int = 0) -> np.ndarray:
    """Simulated decision lateness (s): lognormal (p50 0.77 s, p99 17.3 s); every signal in a backlog hour is > 60 s late."""
    ids = sig["episode_id"].to_numpy()
    lat = lognormal(uniform(ids, "lateness", seed), p.lateness_mu, p.lateness_sigma)
    if chaos.backlog_hours:
        h = ((sig["t_ms"].to_numpy() + T0_MS) // 3_600_000) * 3600
        lat = np.where(np.isin(h, np.fromiter(chaos.backlog_hours, dtype=np.int64)), np.maximum(lat, chaos.backlog_lateness_s), lat)
    return lat


def add_gates(sig: pd.DataFrame, tape: SwapTape, p: SimParams = SimParams(), chaos: Chaos = Chaos(), seed: int = 0) -> pd.DataFrame:
    """lateness_s, t_dec (ms), gate_too_late / gate_pumpswap_hiprice / gate_young_amm and `gate` (first one that fires, else '')."""
    sig = sig.copy()
    sig["lateness_s"] = lateness(sig, p, chaos, seed)
    sig["t_dec"] = sig["t_ms"].to_numpy() + np.round(sig["lateness_s"].to_numpy() * 1000).astype(np.int64)
    sig["gate_too_late"] = sig["lateness_s"].to_numpy() > p.max_copy_delay_s
    v = sig["venue_clean"]
    sig["gate_pumpswap_hiprice"] = v.str.startswith("pumpswap").to_numpy() & (sig["leader_price_sol"].fillna(0).to_numpy() >= HIPRICE)
    mc = tape.codes(sig["mint"])
    t = sig["t_dec"].to_numpy()
    first = tape.first_t(mc, t)
    young = (first < 0) | (first >= t - YOUNG_MS)
    sig["gate_young_amm"] = v.isin(YOUNG_AMM_VENUES).to_numpy() & young
    g = np.full(len(sig), "", dtype=object)
    for name in reversed(GATES):
        g = np.where(sig[f"gate_{name}"].to_numpy(), name, g)
    sig["gate"] = g
    return sig


def leader_sells(sig: pd.DataFrame, tape: SwapTape, horizon_ms: int = 25 * 3_600_000) -> dict[str, np.ndarray]:
    """
    The leader's sells of the signal's mint after the copied buy (ts, then id order), within `horizon_ms`, as CSR arrays:
    off (len n + 1), t (ms), tokens, bal (token_balance_before), ins (insert time, ms). leader_sold_frac uses
    leader_pos_tokens from the episode.
    """
    n = len(sig)
    s = tape.side < 0
    sells = pd.DataFrame({"w": tape.wallet[s].astype(np.int64), "m": tape.mint[s].astype(np.int64), "t": tape.t[s], "id": tape.id[s],
                          "tok": tape.tokens[s], "bal": tape.bal[s], "ins": tape.ins[s]})
    q = pd.DataFrame({"i": np.arange(n), "w": tape.wcodes(sig["leader"]), "m": tape.codes(sig["mint"]), "bt": sig["t_ms"].to_numpy(),
                      "bid": sig["episode_id"].to_numpy()})
    j = q.merge(sells, on=["w", "m"], how="inner")
    after = (j["t"] > j["bt"]) | ((j["t"] == j["bt"]) & (j["id"] > j["bid"]))
    j = j[after & (j["t"] <= j["bt"] + horizon_ms)].sort_values(["i", "t", "id"], kind="stable")
    cnt = np.bincount(j["i"].to_numpy(), minlength=n)
    return {"off": np.r_[0, np.cumsum(cnt)].astype(np.int64), "t": j["t"].to_numpy(np.int64), "tokens": j["tok"].to_numpy(np.float64),
            "bal": j["bal"].to_numpy(np.float64), "ins": j["ins"].to_numpy(np.int64)}
