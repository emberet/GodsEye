//! The JSON fixture / replay format: a gRPC transaction update with bytes written as base58 (errors as hex).
//! Shared with agent/src/stream/fixture.ts, so the same file drives the Rust service's replay mode, the golden tests
//! and both benchmarks. One JSON object per line (NDJSON).

use serde::Deserialize;

use crate::convert::{GrpcMessage, GrpcMeta, GrpcTokenBalance, GrpcTxInfo};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureTx {
    #[serde(default)]
    pub name: Option<String>,
    pub slot: u64,
    pub received_at_ms: f64,
    /// SOL's USD price to parse with (stands in for market/solprice.ts); null = unknown.
    #[serde(default)]
    pub sol_usd: Option<f64>,
    pub info: FxInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxInfo {
    pub signature: String,
    #[serde(default)]
    pub is_vote: bool,
    #[serde(default)]
    pub transaction: Option<FxTransaction>,
    #[serde(default)]
    pub meta: Option<FxMeta>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxTransaction {
    #[serde(default)]
    pub message: Option<FxMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxMessage {
    #[serde(default)]
    pub header: Option<FxHeader>,
    pub account_keys: Vec<String>,
    pub instructions: Vec<FxIx>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxHeader {
    pub num_required_signatures: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxIx {
    pub program_id_index: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxInner {
    pub instructions: Vec<FxIx>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxErr {
    /// Hex of the serialized error.
    pub err: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxAmount {
    pub amount: String,
    pub decimals: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxTokenBalance {
    pub account_index: u32,
    pub mint: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub ui_token_amount: Option<FxAmount>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxMeta {
    #[serde(default)]
    pub err: Option<FxErr>,
    pub fee: String,
    pub pre_balances: Vec<String>,
    pub post_balances: Vec<String>,
    #[serde(default)]
    pub inner_instructions: Vec<FxInner>,
    #[serde(default)]
    pub pre_token_balances: Vec<FxTokenBalance>,
    #[serde(default)]
    pub post_token_balances: Vec<FxTokenBalance>,
    #[serde(default)]
    pub loaded_writable_addresses: Vec<String>,
    #[serde(default)]
    pub loaded_readonly_addresses: Vec<String>,
}

fn b58(s: &str) -> Result<Vec<u8>, String> {
    bs58::decode(s)
        .into_vec()
        .map_err(|e| format!("bad base58 {s:?}: {e}"))
}

fn hex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("bad hex {s:?}"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| format!("bad hex {s:?}: {e}")))
        .collect()
}

fn num(s: &str) -> Result<u64, String> {
    s.parse::<u64>()
        .map_err(|e| format!("bad integer {s:?}: {e}"))
}

impl FixtureTx {
    pub fn parse_line(line: &str) -> Result<FixtureTx, String> {
        serde_json::from_str(line).map_err(|e| e.to_string())
    }

    pub fn to_grpc(&self) -> Result<GrpcTxInfo, String> {
        let i = &self.info;
        let tb = |b: &FxTokenBalance| GrpcTokenBalance {
            account_index: b.account_index,
            mint: b.mint.clone(),
            owner: b.owner.clone(),
            ui_token_amount: b
                .ui_token_amount
                .as_ref()
                .map(|a| (a.amount.clone(), a.decimals)),
        };
        let message = match i.transaction.as_ref().and_then(|t| t.message.as_ref()) {
            None => None,
            Some(m) => Some(GrpcMessage {
                num_required_signatures: m.header.as_ref().map(|h| h.num_required_signatures),
                account_keys: m
                    .account_keys
                    .iter()
                    .map(|k| b58(k))
                    .collect::<Result<_, _>>()?,
                instructions: m.instructions.iter().map(|x| x.program_id_index).collect(),
            }),
        };
        let meta = match &i.meta {
            None => None,
            Some(m) => Some(GrpcMeta {
                err: m.err.as_ref().map(|e| hex(&e.err)).transpose()?,
                fee: num(&m.fee)?,
                pre_balances: m
                    .pre_balances
                    .iter()
                    .map(|v| num(v))
                    .collect::<Result<_, _>>()?,
                post_balances: m
                    .post_balances
                    .iter()
                    .map(|v| num(v))
                    .collect::<Result<_, _>>()?,
                inner_instructions: m
                    .inner_instructions
                    .iter()
                    .map(|ii| ii.instructions.iter().map(|x| x.program_id_index).collect())
                    .collect(),
                pre_token_balances: m.pre_token_balances.iter().map(tb).collect(),
                post_token_balances: m.post_token_balances.iter().map(tb).collect(),
                loaded_writable_addresses: m
                    .loaded_writable_addresses
                    .iter()
                    .map(|k| b58(k))
                    .collect::<Result<_, _>>()?,
                loaded_readonly_addresses: m
                    .loaded_readonly_addresses
                    .iter()
                    .map(|k| b58(k))
                    .collect::<Result<_, _>>()?,
            }),
        };
        Ok(GrpcTxInfo {
            signature: b58(&i.signature)?,
            is_vote: i.is_vote,
            message,
            meta,
        })
    }
}
