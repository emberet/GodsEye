"""Phase 4 consumer: the Rust `ge-analyze` tables can only take a 'skill' verdict away, never grant one.

With QUANT_USE_FLOW=on a wallet keeps verdict 'skill' only if
  * wallet_clusters says it is not a 'follower' and not in a 'sybil' cluster, and
  * backtest_results has a delayed-copy return > 0 for it (missing or stale row = not proven = 'luck').
skill_score is multiplied by wallet_clusters.independent_score (1.0 if the wallet has no row).
Rows older than flow_max_age_hours are treated as missing. Missing tables = every 'skill' becomes 'luck'.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

import pandas as pd

from .config import QuantConfig
from .db import has_table

# Written by rust/ingest/crates/ge-flow (ge-analyze). Kept identical to FLOW_SCHEMA_SQL in its db.rs (tested).
FLOW_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS backtest_results (
  leader TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  n_trades INTEGER NOT NULL,
  n_open INTEGER NOT NULL,
  copy_return_pct REAL,
  copy_pnl_sol REAL NOT NULL,
  ideal_return_pct REAL,
  win_rate REAL,
  max_drawdown REAL NOT NULL,
  delay_sec REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  fee_bps REAL NOT NULL,
  size_sol REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_clusters (
  wallet TEXT PRIMARY KEY,
  cluster_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('independent','leader','follower','sybil')),
  funder TEXT,
  follows TEXT,
  lead_lag_score REAL NOT NULL,
  sync_score REAL NOT NULL,
  independent_score REAL NOT NULL,
  n_mints INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);
"""


@dataclass
class FlowData:
    clusters: dict[str, dict] = field(default_factory=dict)
    backtest: dict[str, float | None] = field(default_factory=dict)


def load_flow(con: sqlite3.Connection, now: int, cfg: QuantConfig) -> FlowData:
    fresh = now - int(cfg.flow_max_age_hours * 3600)
    out = FlowData()
    if has_table(con, "wallet_clusters"):
        for w, role, ind in con.execute(
            "SELECT wallet, role, independent_score FROM wallet_clusters WHERE computed_at >= ?", (fresh,)
        ):
            out.clusters[w] = {"role": role, "independent_score": ind}
    if has_table(con, "backtest_results"):
        for w, ret in con.execute(
            "SELECT leader, copy_return_pct FROM backtest_results WHERE computed_at >= ?", (fresh,)
        ):
            out.backtest[w] = ret
    return out


def apply_flow(skill: pd.DataFrame, flow: FlowData) -> tuple[pd.DataFrame, dict]:
    stats = {"follower_or_sybil": 0, "copy_return_not_positive": 0}
    if not len(skill):
        return skill, stats
    df = skill.copy()
    for i, row in df.iterrows():
        c = flow.clusters.get(row["wallet"])
        ind = 1.0 if c is None or c["independent_score"] is None else float(c["independent_score"])
        df.at[i, "skill_score"] = float(row["skill_score"] or 0.0) * max(0.0, min(1.0, ind))
        if row["verdict"] != "skill":
            continue
        if c is not None and c["role"] in ("follower", "sybil"):
            df.at[i, "verdict"] = "luck"
            stats["follower_or_sybil"] += 1
            continue
        ret = flow.backtest.get(row["wallet"])
        if ret is None or not ret > 0:
            df.at[i, "verdict"] = "luck"
            stats["copy_return_not_positive"] += 1
    stats["skill_after"] = int((df["verdict"] == "skill").sum())
    return df, stats
