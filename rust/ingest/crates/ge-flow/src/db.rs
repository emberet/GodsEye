//! SQLite I/O. The source DB is opened `mode=ro` (plus `query_only`) for every read; results are
//! written through a separate, short-lived write connection in one transaction, only to the two
//! tables this crate owns (`backtest_results`, `wallet_clusters`). Existing tables are never written.

use crate::backtest::{LeaderResult, Params};
use crate::flow::WalletFlow;
use crate::{time::iso_to_ms, Swap};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

pub const FLOW_SCHEMA_SQL: &str = "
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
";

pub fn open_ro(path: &Path) -> rusqlite::Result<Connection> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    c.pragma_update(None, "query_only", "ON")?;
    Ok(c)
}

fn has_column(c: &Connection, table: &str, col: &str) -> rusqlite::Result<bool> {
    let mut st = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<_, _>>()?;
    Ok(names.iter().any(|n| n == col))
}

/// Swaps with `ts >= since_ms` (all if None). Rows with unparsable time or non-positive price are skipped.
pub fn load_swaps(c: &Connection, since_ms: Option<i64>) -> rusqlite::Result<Vec<Swap>> {
    let bal = if has_column(c, "wallet_swaps", "token_balance_before")? {
        "token_balance_before"
    } else {
        "0"
    };
    let mut st = c.prepare(&format!(
        "SELECT wallet, mint, ts, side, token_amount, {bal}, sol_amount, price_sol
           FROM wallet_swaps WHERE price_sol > 0 ORDER BY id"
    ))?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, f64>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, f64>(6)?,
            r.get::<_, f64>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    let mut names: HashMap<String, Arc<str>> = HashMap::new();
    let mut intern = |s: String| -> Arc<str> {
        if let Some(a) = names.get(&s) {
            return a.clone();
        }
        let a: Arc<str> = Arc::from(s.as_str());
        names.insert(s, a.clone());
        a
    };
    for row in rows {
        let (wallet, mint, ts, side, ta, tb, sol, price) = row?;
        let Some(t) = iso_to_ms(&ts) else { continue };
        if since_ms.is_some_and(|s| t < s) {
            continue;
        }
        out.push(Swap {
            wallet: intern(wallet),
            mint: intern(mint),
            t,
            buy: side == "buy",
            token_amount: ta,
            token_balance_before: tb,
            sol_amount: sol,
            price,
        });
    }
    Ok(out)
}

/// wallet -> first funder, from `wallets.funder` (empty if the table/column is missing).
pub fn load_funders(c: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let exists: bool = c
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallets'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists || !has_column(c, "wallets", "funder")? {
        return Ok(HashMap::new());
    }
    let mut st =
        c.prepare("SELECT address, funder FROM wallets WHERE funder IS NOT NULL AND funder != ''")?;
    let m = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(m)
}

/// Leaders worth backtesting: wallets with at least `min_closed` rows in closed_trades (falls back to
/// every wallet that bought something when closed_trades doesn't exist).
pub fn load_leaders(
    c: &Connection,
    swaps: &[Swap],
    min_closed: u32,
) -> rusqlite::Result<Vec<String>> {
    let exists: bool = c
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='closed_trades'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        let mut st = c.prepare(
            "SELECT wallet FROM closed_trades GROUP BY wallet HAVING COUNT(*) >= ? ORDER BY wallet",
        )?;
        let v = st
            .query_map([min_closed], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        return Ok(v);
    }
    let mut v: Vec<String> = swaps
        .iter()
        .filter(|s| s.buy)
        .map(|s| s.wallet.to_string())
        .collect();
    v.sort();
    v.dedup();
    Ok(v)
}

pub fn write_results(
    path: &Path,
    now: i64,
    p: &Params,
    bt: &[LeaderResult],
    flow: &[WalletFlow],
) -> rusqlite::Result<()> {
    let mut c = Connection::open(path)?;
    c.busy_timeout(std::time::Duration::from_secs(10))?;
    c.execute_batch(FLOW_SCHEMA_SQL)?;
    let tx = c.transaction()?;
    {
        let mut a = tx.prepare(
            "INSERT OR REPLACE INTO backtest_results (leader, computed_at, n_trades, n_open, copy_return_pct, copy_pnl_sol,
               ideal_return_pct, win_rate, max_drawdown, delay_sec, slippage_bps, fee_bps, size_sol)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        )?;
        for r in bt {
            a.execute(rusqlite::params![
                r.leader,
                now,
                r.n_trades as i64,
                r.n_open as i64,
                r.copy_return_pct,
                r.copy_pnl_sol,
                r.ideal_return_pct,
                r.win_rate,
                r.max_drawdown_sol,
                p.delay_sec,
                p.slippage_bps,
                p.fee_bps,
                p.size_sol
            ])?;
        }
        let mut b = tx.prepare(
            "INSERT OR REPLACE INTO wallet_clusters (wallet, cluster_id, role, funder, follows, lead_lag_score, sync_score,
               independent_score, n_mints, computed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )?;
        for w in flow {
            b.execute(rusqlite::params![
                w.wallet,
                w.cluster_id,
                w.role,
                w.funder,
                w.follows,
                w.lead_lag_score,
                w.sync_score,
                w.independent_score,
                w.n_mints as i64,
                now
            ])?;
        }
    }
    tx.commit()
}
