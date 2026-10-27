//! GodsEye swap parsing in Rust: a byte-for-byte port of the TypeScript parser (agent/src/chain/parse.ts), the gRPC
//! update converter (agent/src/stream/convert.ts) and the bot signs used by the organic/smart-money gates.
//! It reads transactions only. Nothing here can sign or send one.

pub mod bot;
pub mod convert;
pub mod fixture;
pub mod jsnum;
pub mod parse;
pub mod programs;
pub mod tx;

pub use convert::{convert_grpc_tx, Converted, GrpcTxInfo};
pub use parse::{parse_swap, parse_swaps, swaps_to_js_json, ParseOptions, ParsedSwap, Side};
pub use tx::Tx;

/// What the live stream does with one update (stream.ts `onUpdate`): every signer's swaps, signers in order.
pub fn swaps_for_update(conv: &Converted, opts: &ParseOptions) -> Vec<ParsedSwap> {
    let mut out = Vec::new();
    for signer in &conv.signers {
        out.extend(parse_swaps(&conv.tx, signer, opts));
    }
    out
}

/// A fixture line -> the swaps the TypeScript stream would produce for it, as `JSON.stringify` prints them.
pub fn fixture_to_js_json(fx: &fixture::FixtureTx) -> Result<String, String> {
    let info = fx.to_grpc()?;
    let price = fx.sol_usd;
    let f = move |_ts: f64| price;
    let opts = ParseOptions {
        sol_usd_at: Some(&f),
    };
    Ok(match convert_grpc_tx(&info, fx.slot, fx.received_at_ms) {
        None => "null".to_string(),
        Some(c) => swaps_to_js_json(&swaps_for_update(&c, &opts)),
    })
}
