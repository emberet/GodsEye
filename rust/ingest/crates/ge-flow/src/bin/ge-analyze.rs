//! `ge-analyze` — offline backtest + money-flow job. Reads the DB read-only, writes only
//! backtest_results / wallet_clusters (skipped with --dry-run). Never signs or touches the network.
//!
//!   ge-analyze [--db PATH] [--dry-run] [--json] [--days 30] [--min-closed 5] [--threads N]
//!              [--delay 5] [--slippage-bps 100] [--fee-bps 100] [--size 0.1] [--depth SOL]
//!              [--follow-window 120] [--sync-sec 2] [--min-events 3]
//!
//! DB path: --db, else $GODSEYE_DB_PATH, else data/godseye.db (relative to the current directory).
use ge_flow::{backtest, db, flow};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    if let Err(e) = run() {
        eprintln!("ge-analyze: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |n: &str| {
        args.iter()
            .position(|a| a == n)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let num = |n: &str, d: f64| -> Result<f64, String> {
        match flag(n) {
            None => Ok(d),
            Some(v) => v
                .parse::<f64>()
                .ok()
                .filter(|x| x.is_finite() && *x >= 0.0)
                .ok_or(format!("{n} needs a number, got {v}")),
        }
    };
    let path = flag("--db")
        .or_else(|| {
            std::env::var("GODSEYE_DB_PATH")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/godseye.db"));
    if !path.exists() {
        return Err(format!("database not found: {}", path.display()).into());
    }
    let dry = args.iter().any(|a| a == "--dry-run");
    let mut p = backtest::Params {
        delay_sec: num("--delay", 5.0)?,
        slippage_bps: num("--slippage-bps", 100.0)?,
        fee_bps: num("--fee-bps", 100.0)?,
        size_sol: num("--size", 0.1)?,
        ..Default::default()
    };
    if flag("--depth").is_some() {
        p.fixed_depth_sol = Some(num("--depth", 30.0)?);
    }
    let fp = flow::FlowParams {
        follow_window_sec: num("--follow-window", 120.0)?,
        sync_sec: num("--sync-sec", 2.0)?,
        min_events: num("--min-events", 3.0)? as u32,
        ..Default::default()
    };
    let threads = num(
        "--threads",
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4) as f64,
    )? as usize;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    let since = flag("--days")
        .map(|_| num("--days", 30.0))
        .transpose()?
        .map(|d| (now as f64 * 1000.0 - d * 86_400_000.0) as i64);

    let t0 = Instant::now();
    let (swaps, funders, leaders) = {
        let c = db::open_ro(&path)?;
        let s = db::load_swaps(&c, since)?;
        let f = db::load_funders(&c)?;
        let l = db::load_leaders(&c, &s, num("--min-closed", 5.0)? as u32)?;
        (s, f, l)
    };
    let t_load = t0.elapsed();
    let t1 = Instant::now();
    let market = backtest::Market::new(&swaps);
    let bt = backtest::backtest_all(&market, &leaders, &p, threads);
    let t_bt = t1.elapsed();
    let t2 = Instant::now();
    let fl = flow::analyse(&swaps, &funders, &fp);
    let t_flow = t2.elapsed();
    if !dry {
        db::write_results(&path, now, &p, &bt, &fl)?;
    }
    let count = |r: &str| fl.iter().filter(|w| w.role == r).count();
    let summary = serde_json::json!({
        "swaps": swaps.len(), "leaders": leaders.len(), "backtested_trades": bt.iter().map(|r| r.n_trades).sum::<usize>(),
        "positive_copy_return": bt.iter().filter(|r| r.copy_return_pct.is_some_and(|x| x > 0.0)).count(),
        "wallets": fl.len(), "sybil": count("sybil"), "follower": count("follower"), "leader": count("leader"),
        "independent": count("independent"), "load_ms": t_load.as_millis(), "backtest_ms": t_bt.as_millis(),
        "flow_ms": t_flow.as_millis(), "dry_run": dry, "delay_sec": p.delay_sec, "slippage_bps": p.slippage_bps,
    });
    if args.iter().any(|a| a == "--json") {
        println!(
            "{}",
            serde_json::json!({ "summary": summary, "backtest": bt, "clusters": fl })
        );
    } else {
        println!("{summary}");
    }
    Ok(())
}
