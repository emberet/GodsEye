//! The wire format: one JSON object per line on GE_INGEST_SOCKET. Schema v1 (documented in rust/ingest/README.md):
//!
//! {"v":1,"signature":"…","slot":123,"receivedAtMs":1760000000123,"lagMs":42|null,"signers":["…"],
//!  "needsPrice":false,"swaps":[ParsedSwap…],"tx":TxLike}
//!
//! `swaps` are parsed WITHOUT a SOL/USD price (the service has no price feed): `solUsd` and `usdAmount` are null and swaps
//! paid in USDC/USDT are absent. `needsPrice` is true when a signer's USDC/USDT balance is in the transaction, so the
//! consumer re-parses `tx` with its own price. `tx` is the converted transaction exactly as convert.ts builds it.

use ge_parse::jsnum::{js_number, js_string};
use ge_parse::programs::{USDC_MINT, USDT_MINT};
use ge_parse::tx::TokenBalance;
use ge_parse::{Converted, ParsedSwap};

pub const SCHEMA_VERSION: u32 = 1;

/// True when a signer holds USDC/USDT in this transaction (its swaps need a SOL/USD price to parse).
pub fn needs_price(conv: &Converted) -> bool {
    let Some(meta) = &conv.tx.meta else {
        return false;
    };
    meta.pre_token_balances
        .iter()
        .chain(meta.post_token_balances.iter())
        .any(|b| {
            (b.mint == USDC_MINT || b.mint == USDT_MINT)
                && b.owner.as_ref().is_some_and(|o| conv.signers.contains(o))
        })
}

fn list<T>(xs: &[T], f: impl Fn(&T) -> String) -> String {
    let mut s = String::from("[");
    for (i, x) in xs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&f(x));
    }
    s.push(']');
    s
}

fn token_balance(b: &TokenBalance) -> String {
    format!(
        "{{\"accountIndex\":{},\"mint\":{},\"owner\":{},\"uiTokenAmount\":{{\"amount\":{},\"decimals\":{}}}}}",
        b.account_index,
        js_string(&b.mint),
        b.owner.as_deref().map(js_string).unwrap_or_else(|| "null".into()),
        js_string(&b.amount),
        b.decimals
    )
}

/// The converted transaction in the TxLike JSON shape (keys and program ids as plain strings).
pub fn tx_json(conv: &Converted) -> String {
    let tx = &conv.tx;
    let meta = match &tx.meta {
        None => "null".to_string(),
        Some(m) => format!(
            "{{\"err\":{},\"fee\":{},\"preBalances\":{},\"postBalances\":{},\"preTokenBalances\":{},\"postTokenBalances\":{},\"innerInstructions\":{}}}",
            if m.err { "{\"failed\":true}" } else { "null" },
            js_number(m.fee),
            list(&m.pre_balances, |v| js_number(*v)),
            list(&m.post_balances, |v| js_number(*v)),
            list(&m.pre_token_balances, token_balance),
            list(&m.post_token_balances, token_balance),
            list(&m.inner_instructions, |ii| format!("{{\"instructions\":{}}}", list(ii, |p| format!("{{\"programId\":{}}}", js_string(p))))),
        ),
    };
    format!(
        "{{\"slot\":{},\"blockTime\":{},\"meta\":{},\"transaction\":{{\"signatures\":{},\"message\":{{\"accountKeys\":{},\"instructions\":{}}}}}}}",
        js_number(tx.slot),
        tx.block_time.map(js_number).unwrap_or_else(|| "null".into()),
        meta,
        list(&tx.signatures, |s| js_string(s)),
        list(&tx.account_keys, |k| format!("{{\"pubkey\":{}}}", js_string(k))),
        list(&tx.instructions, |p| format!("{{\"programId\":{}}}", js_string(p))),
    )
}

/// One event line (without the trailing newline).
pub fn event_line(
    conv: &Converted,
    swaps: &[ParsedSwap],
    received_at_ms: f64,
    lag_ms: Option<i64>,
) -> String {
    format!(
        "{{\"v\":{},\"signature\":{},\"slot\":{},\"receivedAtMs\":{},\"lagMs\":{},\"signers\":{},\"needsPrice\":{},\"swaps\":{},\"tx\":{}}}",
        SCHEMA_VERSION,
        js_string(conv.tx.signatures.first().map(String::as_str).unwrap_or("")),
        js_number(conv.tx.slot),
        js_number(received_at_ms),
        lag_ms.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
        list(&conv.signers, |s| js_string(s)),
        needs_price(conv),
        ge_parse::swaps_to_js_json(swaps),
        tx_json(conv),
    )
}
