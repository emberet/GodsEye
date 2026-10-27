//! Port of agent/src/stream/convert.ts: a Yellowstone gRPC transaction update -> the `Tx` the parser reads.
//! Account order matches Solana's: static keys, then lookup-table writable, then lookup-table read-only addresses.

use crate::tx::{Meta, TokenBalance, Tx};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrpcTokenBalance {
    pub account_index: u32,
    pub mint: String,
    pub owner: String,
    /// `uiTokenAmount` (amount, decimals); None when the update omits it.
    pub ui_token_amount: Option<(String, u32)>,
}

/// The fields of a gRPC `SubscribeUpdateTransactionInfo` GodsEye reads (twin of `GrpcTxInfo` in convert.ts).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrpcTxInfo {
    pub signature: Vec<u8>,
    pub is_vote: bool,
    pub message: Option<GrpcMessage>,
    pub meta: Option<GrpcMeta>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrpcMessage {
    pub num_required_signatures: Option<u32>,
    pub account_keys: Vec<Vec<u8>>,
    pub instructions: Vec<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct GrpcMeta {
    /// The serialized TransactionError bytes (`meta.err.err`), if any.
    pub err: Option<Vec<u8>>,
    pub fee: u64,
    pub pre_balances: Vec<u64>,
    pub post_balances: Vec<u64>,
    pub inner_instructions: Vec<Vec<u32>>,
    pub pre_token_balances: Vec<GrpcTokenBalance>,
    pub post_token_balances: Vec<GrpcTokenBalance>,
    pub loaded_writable_addresses: Vec<Vec<u8>>,
    pub loaded_readonly_addresses: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Converted {
    pub tx: Tx,
    pub signers: Vec<String>,
}

/// `convertGrpcTx`. None for votes and updates without a message or meta.
pub fn convert_grpc_tx(info: &GrpcTxInfo, slot: u64, received_at_ms: f64) -> Option<Converted> {
    let msg = info.message.as_ref()?;
    let meta = info.meta.as_ref()?;
    if info.is_vote {
        return None;
    }
    let keys: Vec<String> = msg
        .account_keys
        .iter()
        .chain(meta.loaded_writable_addresses.iter())
        .chain(meta.loaded_readonly_addresses.iter())
        .map(|k| b58(k))
        .collect();
    let prog = |i: u32| keys.get(i as usize).cloned().unwrap_or_default();
    let bal = |b: &GrpcTokenBalance| {
        let (amount, decimals) = b.ui_token_amount.clone().unwrap_or_else(|| ("0".into(), 0));
        TokenBalance {
            account_index: b.account_index as usize,
            mint: b.mint.clone(),
            owner: Some(b.owner.clone()),
            amount,
            decimals,
        }
    };
    let tx = Tx {
        slot: slot as f64,
        block_time: Some((received_at_ms / 1000.0).floor()),
        meta: Some(Meta {
            err: meta.err.as_ref().is_some_and(|e| !e.is_empty()),
            fee: meta.fee as f64,
            pre_balances: meta.pre_balances.iter().map(|v| *v as f64).collect(),
            post_balances: meta.post_balances.iter().map(|v| *v as f64).collect(),
            pre_token_balances: meta.pre_token_balances.iter().map(bal).collect(),
            post_token_balances: meta.post_token_balances.iter().map(bal).collect(),
            inner_instructions: meta
                .inner_instructions
                .iter()
                .map(|ii| ii.iter().map(|i| prog(*i)).collect())
                .collect(),
        }),
        signatures: vec![b58(&info.signature)],
        account_keys: keys.clone(),
        instructions: msg.instructions.iter().map(|i| prog(*i)).collect(),
    };
    let n = msg.num_required_signatures.unwrap_or(1) as usize;
    let signers = keys.iter().take(n).cloned().collect();
    Some(Converted { tx, signers })
}

/// Base58 like bs58.encode in Node. Fast paths for 32-byte keys and 64-byte signatures (five8), bs58 otherwise.
pub fn b58(bytes: &[u8]) -> String {
    if let Ok(b) = <&[u8; 32]>::try_from(bytes) {
        let mut out = [0u8; 44];
        let n = five8::encode_32(b, &mut out) as usize;
        return String::from_utf8_lossy(&out[..n]).into_owned();
    }
    if let Ok(b) = <&[u8; 64]>::try_from(bytes) {
        let mut out = [0u8; 88];
        let n = five8::encode_64(b, &mut out) as usize;
        return String::from_utf8_lossy(&out[..n]).into_owned();
    }
    bs58::encode(bytes).into_string()
}

#[cfg(test)]
mod b58_tests {
    #[test]
    fn fast_paths_match_bs58() {
        let mut seed = 0x1234_5678_9abc_def0u64;
        for len in [0usize, 1, 31, 32, 33, 64, 65] {
            for zeros in 0..4 {
                let v: Vec<u8> = (0..len)
                    .map(|i| {
                        seed = seed
                            .wrapping_mul(6364136223846793005)
                            .wrapping_add(1442695040888963407);
                        if i < zeros {
                            0
                        } else {
                            (seed >> 33) as u8
                        }
                    })
                    .collect();
                assert_eq!(super::b58(&v), bs58::encode(&v).into_string());
            }
        }
        assert_eq!(
            super::b58(&[0u8; 32]),
            bs58::encode([0u8; 32]).into_string()
        );
        assert_eq!(
            super::b58(&[255u8; 64]),
            bs58::encode([255u8; 64]).into_string()
        );
    }
}
