//! Golden equivalence: for every fixture, the Rust output must equal the TypeScript output byte for byte.
//! Goldens are produced by `npm run rust:fixtures -w agent -- golden` (agent/src/cli/rust-fixtures.ts).

use std::path::PathBuf;

use ge_parse::bot::{
    bot_reason, closed_last_30d, median_hold_sec, same_block_round_trips, tx_per_hour, BotCfg,
    BotSigns, ClosedLite,
};
use ge_parse::fixture::FixtureTx;
use ge_parse::fixture_to_js_json;
use ge_parse::jsnum::{js_number, js_string};
use serde::Deserialize;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn lines(name: &str) -> Vec<String> {
    std::fs::read_to_string(dir().join(name))
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(String::from)
        .collect()
}

fn check_set(set: &str) -> (usize, usize) {
    let fx = lines(&format!("{set}.ndjson"));
    let golden = lines(&format!("{set}.golden.ndjson"));
    assert_eq!(
        fx.len(),
        golden.len(),
        "{set}: fixture and golden line counts differ"
    );
    let mut bad = Vec::new();
    let mut swaps = 0;
    for (i, (f, g)) in fx.iter().zip(golden.iter()).enumerate() {
        let tx = FixtureTx::parse_line(f).unwrap_or_else(|e| panic!("{set}:{i}: {e}"));
        let got = fixture_to_js_json(&tx).unwrap_or_else(|e| panic!("{set}:{i}: {e}"));
        swaps += got.matches("\"wallet\"").count();
        if &got != g {
            bad.push(format!(
                "{set}:{} {}\n  ts:   {g}\n  rust: {got}",
                i + 1,
                tx.name.unwrap_or_default()
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        fx.len(),
        bad.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
    );
    (fx.len(), swaps)
}

#[test]
fn golden_tests_set() {
    let (n, s) = check_set("tests");
    eprintln!("tests: {n} transactions, {s} swaps identical");
}

#[test]
fn golden_synthetic_set() {
    let (n, s) = check_set("synthetic");
    eprintln!("synthetic: {n} transactions, {s} swaps identical");
}

#[test]
fn golden_real_set() {
    let (n, s) = check_set("real");
    eprintln!("real: {n} transactions, {s} swaps identical");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosedIn {
    opened_at_ms: f64,
    closed_at_ms: f64,
    opened_slot: Option<f64>,
    closed_slot: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfgIn {
    min_hold_sec: f64,
    max_tx_per_hour: f64,
    max_same_block: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotCase {
    closed: Vec<ClosedIn>,
    now_ms: f64,
    signatures_seen: f64,
    oldest_seen_at_ms: Option<f64>,
    cfg: CfgIn,
}

#[test]
fn golden_bot_signs() {
    let cases = lines("bot.ndjson");
    let golden = lines("bot.golden.ndjson");
    assert_eq!(cases.len(), golden.len());
    for (i, (c, g)) in cases.iter().zip(golden.iter()).enumerate() {
        let c: BotCase = serde_json::from_str(c).expect("bot case");
        let closed: Vec<ClosedLite> = c
            .closed
            .iter()
            .map(|x| ClosedLite {
                opened_at_ms: x.opened_at_ms,
                closed_at_ms: x.closed_at_ms,
                opened_slot: x.opened_slot,
                closed_slot: x.closed_slot,
            })
            .collect();
        let c30 = closed_last_30d(&closed, c.now_ms);
        let med = median_hold_sec(&c30);
        let same = same_block_round_trips(&c30) as f64;
        let tph = tx_per_hour(c.signatures_seen, c.oldest_seen_at_ms, c.now_ms);
        let cfg = BotCfg {
            min_hold_sec: c.cfg.min_hold_sec,
            max_tx_per_hour: c.cfg.max_tx_per_hour,
            max_same_block: c.cfg.max_same_block,
        };
        let reason = bot_reason(
            &BotSigns {
                median_hold_sec: med,
                tx_per_hour: tph,
                same_block_round_trips: Some(same),
            },
            &cfg,
        );
        let opt = |v: Option<f64>| v.map(js_number).unwrap_or_else(|| "null".into());
        let got =
            format!(
            "{{\"medianHoldSec\":{},\"sameBlockRoundTrips\":{},\"txPerHour\":{},\"reason\":{}}}",
            opt(med),
            js_number(same),
            opt(tph),
            reason.as_deref().map(js_string).unwrap_or_else(|| "null".into())
        );
        assert_eq!(&got, g, "bot case {}", i + 1);
    }
    eprintln!("bot: {} cases identical", cases.len());
}
