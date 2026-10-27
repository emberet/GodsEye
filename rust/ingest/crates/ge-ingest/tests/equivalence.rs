//! ge-ingest equivalence tests:
//! 1. protobuf round trip: fixture -> SubscribeUpdateTransactionInfo -> bytes -> decode -> same GrpcTxInfo.
//! 2. price application: for events with `needsPrice == false`, swaps parsed without a price plus the price applied the
//!    way agent/src/stream/rust-client.ts does it equal the TypeScript goldens byte for byte.
//! 3. the event lines for the real and tests sets equal fixtures/<set>.events.ndjson, which the agent test suite
//!    feeds back through the TypeScript parser. Regenerate with GE_UPDATE_EVENTS=1 cargo test.

use std::path::PathBuf;

use ge_ingest::event::{event_line, needs_price};
use ge_ingest::pb::geyser::SubscribeUpdateTransactionInfo;
use ge_ingest::{info_from_proto, proto_from_info};
use ge_parse::fixture::FixtureTx;
use ge_parse::{convert_grpc_tx, swaps_for_update, swaps_to_js_json, ParseOptions};
use prost::Message;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn lines(name: &str) -> Vec<String> {
    std::fs::read_to_string(dir().join(name))
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(String::from)
        .collect()
}

fn fixtures(set: &str) -> Vec<FixtureTx> {
    lines(&format!("{set}.ndjson"))
        .iter()
        .map(|l| FixtureTx::parse_line(l).unwrap())
        .collect()
}

#[test]
fn protobuf_round_trip() {
    let mut n = 0;
    for set in ["tests", "synthetic", "real"] {
        for fx in fixtures(set) {
            let info = fx.to_grpc().unwrap();
            let bytes = proto_from_info(&info).encode_to_vec();
            let back =
                info_from_proto(&SubscribeUpdateTransactionInfo::decode(bytes.as_slice()).unwrap());
            assert_eq!(back, info, "{set} {}", fx.info.signature);
            n += 1;
        }
    }
    eprintln!("protobuf round trip: {n} transactions");
}

#[test]
fn price_applied_in_node_matches_typescript() {
    let none = ParseOptions { sol_usd_at: None };
    let (mut checked, mut fallback) = (0, 0);
    for set in ["tests", "synthetic", "real"] {
        for (fx, golden) in fixtures(set)
            .iter()
            .zip(lines(&format!("{set}.golden.ndjson")))
        {
            let Some(conv) = convert_grpc_tx(&fx.to_grpc().unwrap(), fx.slot, fx.received_at_ms)
            else {
                continue;
            };
            if needs_price(&conv) {
                fallback += 1;
                continue;
            }
            let mut swaps = swaps_for_update(&conv, &none);
            for s in &mut swaps {
                // rust-client.ts applyPrice: solUsd = price; usdAmount = price ? solAmount * price : null
                s.sol_usd = fx.sol_usd;
                s.usd_amount = fx
                    .sol_usd
                    .filter(|p| *p != 0.0 && !p.is_nan())
                    .map(|p| s.sol_amount * p);
            }
            assert_eq!(
                swaps_to_js_json(&swaps),
                golden,
                "{set} {}",
                fx.info.signature
            );
            checked += 1;
        }
    }
    eprintln!("price application: {checked} identical, {fallback} needsPrice (TS fallback)");
}

#[test]
fn event_lines_are_stable() {
    let none = ParseOptions { sol_usd_at: None };
    for set in ["tests", "real"] {
        let mut out = String::new();
        for fx in fixtures(set) {
            if let Some(conv) = convert_grpc_tx(&fx.to_grpc().unwrap(), fx.slot, fx.received_at_ms)
            {
                out.push_str(&event_line(
                    &conv,
                    &swaps_for_update(&conv, &none),
                    fx.received_at_ms,
                    None,
                ));
                out.push('\n');
            }
        }
        let path = dir().join(format!("{set}.events.ndjson"));
        if std::env::var("GE_UPDATE_EVENTS").is_ok() {
            std::fs::write(&path, &out).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(&path).unwrap_or_default(),
            out,
            "{set}.events.ndjson is stale (GE_UPDATE_EVENTS=1)"
        );
    }
}
