//! The organic-versus-bot signs, as pure functions. Ports of:
//!   * `median_hold_sec` and `same_block_round_trips` from `computeStats` (agent/src/analysis/pnl.ts),
//!   * `txPerHourFrom` (agent/src/analysis/pnl.ts, used by analyze.ts),
//!   * `botReason` (agent/src/smart/copy-check.ts), the gate the learning loop and the organic feed apply.
//!
//! Same arithmetic order as the TypeScript, so values and reason strings match byte for byte (golden-tested).

use crate::jsnum::{iso_from_ms, js_number, js_round};

const DAY_MS: f64 = 86_400_000.0;

/// The parts of a closed position (pnl.ts `ClosedPosition`) the bot signs read. Times are epoch milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct ClosedLite {
    pub opened_at_ms: f64,
    pub closed_at_ms: f64,
    pub opened_slot: Option<f64>,
    pub closed_slot: Option<f64>,
}

/// Positions closed in the last 30 days (compared as ISO strings, as computeStats does).
pub fn closed_last_30d(closed: &[ClosedLite], now_ms: f64) -> Vec<&ClosedLite> {
    let since = iso_from_ms(now_ms - 30.0 * DAY_MS);
    closed
        .iter()
        .filter(|c| iso_from_ms(c.closed_at_ms) >= since)
        .collect()
}

/// Median seconds from a position's first buy to its closing sell. None when nothing closed.
pub fn median_hold_sec(closed30: &[&ClosedLite]) -> Option<f64> {
    let mut holds: Vec<f64> = closed30
        .iter()
        .map(|c| (c.closed_at_ms - c.opened_at_ms) / 60_000.0)
        .collect();
    holds.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let secs: Vec<f64> = holds.iter().map(|m| m * 60.0).collect();
    if secs.is_empty() {
        return None;
    }
    let mid = secs.len() >> 1;
    Some(if secs.len() % 2 == 1 {
        secs[mid]
    } else {
        (secs[mid - 1] + secs[mid]) / 2.0
    })
}

/// Closed positions bought and fully sold in the same block.
pub fn same_block_round_trips(closed30: &[&ClosedLite]) -> usize {
    closed30
        .iter()
        .filter(|c| c.opened_slot.is_some() && c.opened_slot == c.closed_slot)
        .count()
}

/// Transactions an hour from a first-look history scan: None below 20 signatures.
pub fn tx_per_hour(
    signatures_seen: f64,
    oldest_seen_at_ms: Option<f64>,
    now_ms: f64,
) -> Option<f64> {
    let span_hours = match oldest_seen_at_ms {
        Some(t) => (now_ms - t) / 3_600_000.0,
        None => 0.0,
    };
    if signatures_seen >= 20.0 {
        Some(signatures_seen / span_hours.max(0.25))
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BotSigns {
    pub median_hold_sec: Option<f64>,
    pub tx_per_hour: Option<f64>,
    pub same_block_round_trips: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BotCfg {
    pub min_hold_sec: f64,
    pub max_tx_per_hour: f64,
    pub max_same_block: f64,
}

impl Default for BotCfg {
    /// The defaults in agent/src/config.ts (SMART_BOT_*).
    fn default() -> Self {
        BotCfg {
            min_hold_sec: 15.0,
            max_tx_per_hour: 20.0,
            max_same_block: 0.0,
        }
    }
}

/// `botReason`: why this wallet looks like a bot, or None. Unknown values never count against it.
pub fn bot_reason(b: &BotSigns, cfg: &BotCfg) -> Option<String> {
    if let Some(h) = b.median_hold_sec {
        if h < cfg.min_hold_sec {
            return Some(format!(
                "bot: median hold {} s (under {} s can't be copied)",
                js_number(js_round(h)),
                js_number(cfg.min_hold_sec)
            ));
        }
    }
    if let Some(r) = b.tx_per_hour {
        if r > cfg.max_tx_per_hour {
            return Some(format!(
                "bot: {} transactions an hour (over {})",
                js_number(js_round(r)),
                js_number(cfg.max_tx_per_hour)
            ));
        }
    }
    let same = b.same_block_round_trips.unwrap_or(0.0);
    if same > cfg.max_same_block {
        let n = b
            .same_block_round_trips
            .map(js_number)
            .unwrap_or_else(|| "null".into());
        let plural = if b.same_block_round_trips == Some(1.0) {
            ""
        } else {
            "s"
        };
        return Some(format!(
            "bot: bought and sold in the same block {n} time{plural}"
        ));
    }
    None
}
