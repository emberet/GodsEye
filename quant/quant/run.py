"""Offline batch job: python -m quant.run [--db PATH] [--dry-run]"""

from __future__ import annotations

import argparse
import json
import math
import time

import numpy as np

from .config import QuantConfig
from .data import load_closed_trades, load_price_paths, load_swaps, price_paths
from .db import db_path, has_table, open_ro, write_results
from .flow import apply_flow, load_flow
from .sizing import sizing_rows
from .stats import analyse

SKILL_COLS = [
    "wallet",
    "computed_at",
    "n_trades",
    "win_rate",
    "median_return",
    "ci_low",
    "ci_high",
    "p_value",
    "q_value",
    "deflated_sharpe",
    "persistence_rho",
    "skill_score",
    "verdict",
]


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return None if math.isnan(float(v)) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    return v


def run(path=None, cfg: QuantConfig | None = None, now: int | None = None, dry_run: bool = False) -> dict:
    cfg = cfg or QuantConfig.from_env()
    path = path or db_path()
    t_now = now if now is not None else int(time.time())
    since = t_now - cfg.window_days * 86400
    con = open_ro(path)
    try:
        if has_table(con, "closed_trades"):
            # price paths only for tokens of wallets with enough trades to be tested (null_returns needs no others)
            trades, source = load_closed_trades(con, since, None, skip_bots=bool(cfg.skip_bots))
            counts = trades["wallet"].value_counts()
            tested = trades[trades["wallet"].isin(counts[counts >= cfg.min_trades].index)]
            paths = load_price_paths(con, since, sorted(tested["mint"].unique()))
        else:
            swaps = load_swaps(con, since)
            trades, source = load_closed_trades(con, since, swaps)
            paths = price_paths(swaps)
        flow = load_flow(con, t_now, cfg) if cfg.use_flow == "on" else None
    finally:
        con.close()
    skill, summary = analyse(trades, paths, cfg, t_now)
    if flow is not None:
        skill, summary["flow"] = apply_flow(skill, flow)
    skill_rows = [{c: _clean(r[c]) for c in SKILL_COLS} for r in skill.to_dict("records")] if len(skill) else []
    sizing = [{k: _clean(v) for k, v in r.items()} for r in sizing_rows(trades, cfg, t_now)]
    if not dry_run:
        write_results(path, skill_rows, sizing)
    summary.update(source=source, trades=len(trades), sizing_rows=len(sizing), dry_run=dry_run)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description="GodsEye quant batch job (offline, never signs)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    print(json.dumps(run(a.db, dry_run=a.dry_run), default=str))


if __name__ == "__main__":
    main()
