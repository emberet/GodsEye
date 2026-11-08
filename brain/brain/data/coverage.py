"""
Coverage numbers for the derived datasets (the figures quoted in brain/research/DATA.md):

    python -m brain.data.coverage            # prints a report, writes DATA_DIR/research/data/coverage.json

Split = train (ts < 2026-11-02 UTC) / test (>= it), plus per-day rows and per period of brain/spec/splits.yaml
(fit / embargo / selection / test), with what known_at_t and the outage mask (ingest outages and the export tail) remove.
"""
from __future__ import annotations

import json
import sys

from brain.data.loaders import connect, data_dir


def q(con, sql: str):
    return con.execute(sql).df()


def main() -> int:
    con = connect()
    out: dict = {}
    names = {r[0] for r in con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall()}
    if "episodes" not in names:
        print("derived/episodes.parquet not built yet: python -m brain.data.derive", file=sys.stderr)
        return 1
    meta_p = data_dir() / "derived" / "_meta.json"
    if meta_p.is_file():
        out["meta"] = json.loads(meta_p.read_text())
    # labels end where the export tail starts (derive.label_end); builds before it censored at the data end
    label_end_t = int(out.get("meta", {}).get("label_end_t") or out.get("meta", {}).get("data_end_t") or 2**62)

    cov_cols = """
        count(*) AS n,
        avg((entry_price_5 IS NOT NULL)::INT) AS has_entry_5,
        avg((entry_price_15 IS NOT NULL)::INT) AS has_entry_15,
        avg((entry_price_30 IS NOT NULL)::INT) AS has_entry_30,
        avg((entry_price_60 IS NOT NULL)::INT) AS has_entry_60,
        avg((ret_1m IS NOT NULL)::INT) AS has_ret_1m,
        avg((ret_5m IS NOT NULL)::INT) AS has_ret_5m,
        avg((ret_1h IS NOT NULL)::INT) AS has_ret_1h,
        avg((ret_6h IS NOT NULL)::INT) AS has_ret_6h,
        avg((ret_24h IS NOT NULL)::INT) AS has_ret_24h,
        avg(censored_24h::INT) FILTER (WHERE entry_price_15 IS NOT NULL) AS censored_24h_of_entered,
        median(n_price_points_24h) FILTER (WHERE entry_price_15 IS NOT NULL) AS median_points_24h_entered,
        median(n_path_minutes) FILTER (WHERE entry_price_15 IS NOT NULL) AS median_path_minutes_entered,
        median(coalesce(n_price_points_24h, 0)) AS median_points_24h_all,
        median(entry_age_15) AS median_entry_age_15,
        quantile_cont(entry_vs_leader_15, 0.5) AS median_entry_vs_leader_15,
        avg((leader_first_sell_sec IS NOT NULL)::INT) AS leader_sold_ever,
        avg(leader_price_ok::INT) AS leader_price_ok,
        avg(known_at_t::INT) AS known_at_t,
        avg(crosses_outage::INT) AS crosses_outage,
        avg((known_at_t AND NOT crosses_outage)::INT) AS kept_known_no_outage,
        avg((epoch(ins_ts) - epoch(ts) > 600)::INT) AS ins_lag_gt_10m,
        count(DISTINCT leader) AS leaders,
        count(DISTINCT mint) AS mints
    """
    overall = q(con, f"SELECT 'all' AS split, {cov_cols} FROM episodes UNION ALL SELECT split, {cov_cols} FROM episodes GROUP BY split ORDER BY split")
    per_day = q(con, f"SELECT day, {cov_cols} FROM episodes GROUP BY day ORDER BY day")
    per_period = q(con, f"SELECT coalesce(period, 'before') AS period, {cov_cols} FROM episodes GROUP BY 1 ORDER BY min(ts)")
    # what the two filters remove, in rows (all episodes, then entered + uncensored: the ones with a 24 h label)
    removed = q(con, f"""
        SELECT coalesce(period, 'before') AS period, count(*) AS n,
               count(*) FILTER (WHERE NOT known_at_t) AS not_known_at_t,
               count(*) FILTER (WHERE crosses_outage) AS crosses_outage,
               count(*) FILTER (WHERE epoch(ts) + 86400 >= {label_end_t}) AS reaches_export_tail,
               count(*) FILTER (WHERE NOT known_at_t OR crosses_outage) AS removed_either,
               count(*) FILTER (WHERE known_at_t AND NOT crosses_outage) AS kept,
               count(*) FILTER (WHERE entry_price_15 IS NOT NULL AND NOT censored_24h) AS labelled,
               count(*) FILTER (WHERE entry_price_15 IS NOT NULL AND NOT censored_24h AND known_at_t AND NOT crosses_outage) AS labelled_kept,
               count(*) FILTER (WHERE leader_sol >= 0.2) AS copy_eligible,
               count(*) FILTER (WHERE leader_sol >= 0.2 AND known_at_t AND NOT crosses_outage) AS copy_eligible_kept
        FROM episodes GROUP BY 1 ORDER BY min(ts)
    """)
    outage = q(con, "SELECT * FROM outage_hours ORDER BY hour") if "outage_hours" in names else None
    # returns among episodes with a 15 s entry and an uncensored 24 h window (labels, for orientation only)
    rets = q(con, """
        SELECT split, count(*) AS n,
               quantile_cont(ret_1h, [0.1, 0.25, 0.5, 0.75, 0.9]) AS ret_1h_q,
               quantile_cont(ret_24h, [0.1, 0.25, 0.5, 0.75, 0.9]) AS ret_24h_q,
               quantile_cont(max_ret_24h, [0.25, 0.5, 0.75, 0.9]) AS max_ret_24h_q,
               avg((minutes_to_stop60 IS NOT NULL)::INT) AS hit_minus60,
               avg((minutes_to_2x IS NOT NULL)::INT) AS hit_2x
        FROM episodes WHERE entry_price_15 IS NOT NULL AND NOT censored_24h GROUP BY split ORDER BY split
    """)
    swaps = q(con, """
        SELECT count(*) AS n, count(DISTINCT mint) AS mints, count(DISTINCT wallet) AS wallets, min(ts) AS first_ts, max(ts) AS last_ts
        FROM wallet_swaps
    """)
    bars = q(con, "SELECT count(*) AS n, count(DISTINCT mint) AS mints, avg((close IS NULL)::INT) AS unpriced_share FROM bars_1m")
    # how sparse is a mint's tape: share of bar-minutes with a price, per mint, over the mint's active span
    density = q(con, """
        WITH m AS (SELECT mint, count(*) FILTER (WHERE close IS NOT NULL) AS priced,
                          (epoch(max(minute)) - epoch(min(minute))) / 60 + 1 AS span FROM bars_1m GROUP BY mint)
        SELECT count(*) AS mints, median(priced) AS median_priced_minutes, median(span) AS median_span_minutes,
               median(priced / span) AS median_density, avg((priced <= 1)::INT) AS share_single_minute_mints
        FROM m
    """)
    paths = q(con, "SELECT count(*) AS rows, count(DISTINCT episode_id) AS episodes FROM episode_paths")
    # share of the 24 h path minutes that have a price (uncensored entered episodes)
    obs = q(con, """
        SELECT split, count(*) AS n, median(n_path_minutes / 1440.0) AS median_share_minutes_priced,
               quantile_cont(n_path_minutes / 1440.0, [0.1, 0.25, 0.75, 0.9]) AS share_q,
               avg((n_path_minutes = 0)::INT) AS share_no_price_after_entry
        FROM episodes WHERE entry_price_15 IS NOT NULL AND NOT censored_24h GROUP BY split ORDER BY split
    """)
    misc = q(con, """
        SELECT avg((leader_first_sell_sec = 0)::INT) AS share_leader_sells_same_second,
               avg((leader_first_sell_sec <= 60)::INT) AS share_leader_sells_within_60s,
               avg((leader_prior_buys_mint = 0)::INT) AS share_first_buy_of_mint,
               avg(src::INT) AS share_from_archive
        FROM episodes
    """)
    # who is in the archive: share of swaps (300k-row samples) whose wallet has a junk_reason today
    junk = q(con, """
        SELECT a.src, count(*) AS n, avg((w.junk_reason IS NOT NULL)::INT) AS share_junk_wallet_today
        FROM (SELECT wallet, 1 AS src FROM wallet_swaps_archive USING SAMPLE 300000 ROWS
              UNION ALL SELECT wallet, 0 AS src FROM wallet_swaps_live USING SAMPLE 300000 ROWS) a
        LEFT JOIN wallets w ON w.address = a.wallet GROUP BY a.src ORDER BY a.src
    """) if "wallet_swaps_archive" in names else None
    # price filter (trailing) on a sample of mints (1/16 by mint hash): how many swaps set no price, and why
    from brain.data import derive
    con.execute("CREATE OR REPLACE TEMP TABLE sw_src AS SELECT *, 0 AS _src FROM wallet_swaps WHERE hash(mint) % 16 = 3")
    derive.prepare_swaps(con, "SELECT * FROM sw_src")
    derive.build_prices(con)
    pfilter = q(con, f"""
        SELECT count(*) AS swaps, avg((NOT valid)::INT) AS share_invalid_or_dust,
               avg((s.token_amount < {derive.MIN_PRICE_TOKENS} AND s.price_sol > 0 AND s.sol_amount >= {derive.MIN_PRICE_SOL})::INT) AS share_sub_token,
               avg((valid AND NOT ok)::INT) AS share_outlier, avg((valid AND lone AND rm BETWEEN 0.1 AND 10)::INT) AS share_lone_only,
               avg(ok::INT) AS share_ok, avg(ok_label::INT) AS share_ok_label
        FROM px p JOIN sw s USING (mint, okey)
    """)
    # end-of-life rug prints: share of mints whose last valid print is rejected as > 10x low, causal vs label filter
    tails = q(con, """
        WITH l AS (SELECT mint, count(*) AS n, arg_max(rm, okey) AS rm, arg_max(ok, okey) AS ok, arg_max(ok_label, okey) AS okl
                   FROM px WHERE valid GROUP BY mint)
        SELECT count(*) AS mints, avg((rm < 0.1 AND NOT ok)::INT) AS last_low_hidden_causal,
               avg((rm < 0.1 AND NOT okl)::INT) AS last_low_hidden_label,
               avg((rm < 0.1 AND NOT ok)::INT) FILTER (WHERE n >= 20) AS last_low_hidden_causal_20plus,
               avg((rm < 0.1 AND NOT okl)::INT) FILTER (WHERE n >= 20) AS last_low_hidden_label_20plus
        FROM l
    """)
    # absurd labels (unit-error runs that pass as prices show up as > 1000x peaks)
    sanity = q(con, """
        SELECT count(*) FILTER (WHERE max_ret_24h > 1000) AS max_ret_gt_1000x,
               count(DISTINCT mint) FILTER (WHERE max_ret_24h > 1000) AS mints_gt_1000x,
               count(*) FILTER (WHERE max_ret_24h > 1000 AND period IN ('fit', 'selection') AND known_at_t AND NOT crosses_outage) AS gt_1000x_in_train_filter,
               max(max_ret_24h) AS max_max_ret_24h,
               avg(ret_24h) AS mean_ret_24h, avg(CASE WHEN ret_24h IS NOT NULL THEN least(ret_24h, 100) END) AS mean_ret_24h_cap100
        FROM episodes
    """)
    # reality check: our real filled copy buys vs the simulated entry for the same leader swap
    real = q(con, """
        WITH c AS (
            SELECT ct.leader_signature, ct.price_sol AS fill_price, epoch(ct.filled_at) - epoch(ct.leader_ts) AS lateness_sec
            FROM copy_trades ct WHERE ct.side = 'buy' AND ct.status = 'filled' AND ct.price_sol > 0
        )
        SELECT count(*) AS n_filled_matched,
               median(lateness_sec) AS median_lateness_sec,
               median(fill_price / e.leader_price_sol - 1) AS median_fill_vs_leader,
               median(fill_price / e.entry_price_15 - 1) AS median_fill_vs_entry15,
               median(abs(fill_price / e.entry_price_15 - 1)) AS median_abs_fill_vs_entry15,
               median(e.entry_vs_leader_15) AS median_entry15_vs_leader_same_rows
        FROM c JOIN episodes e ON e.signature = c.leader_signature
    """) if "copy_trades" in names else None
    for name, df in [("overall", overall), ("per_period", per_period), ("removed", removed), ("outage_hours", outage), ("returns", rets), ("swaps", swaps), ("bars", bars), ("density", density),
                     ("paths", paths), ("observed_minutes", obs), ("misc", misc), ("junk_by_source", junk), ("price_filter_sample", pfilter), ("rug_tails_sample", tails), ("label_sanity", sanity), ("real_fills_vs_sim", real), ("per_day", per_day)]:
        if df is None:
            continue
        print(f"\n== {name}")
        print(df.to_string(index=False))
        out[name] = json.loads(df.to_json(orient="records", date_format="iso"))
    dest = data_dir() / "research" / "data"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "coverage.json").write_text(json.dumps(out, indent=1, default=str))
    print(f"\nwrote {dest / 'coverage.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
