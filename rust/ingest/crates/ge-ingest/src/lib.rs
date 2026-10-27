//! GodsEye ingest: Yellowstone gRPC transaction updates -> normalised swap events (NDJSON) on a unix socket.
//! Read-only by construction: this crate has no keypair, no signer and no send/submit call.

pub mod event;
pub mod metrics;

pub mod pb {
    #![allow(clippy::all, clippy::pedantic)]
    pub mod geyser {
        tonic::include_proto!("geyser");
    }
    pub mod solana {
        pub mod storage {
            pub mod confirmed_block {
                tonic::include_proto!("solana.storage.confirmed_block");
            }
        }
    }
}

use ge_parse::convert::{GrpcMessage, GrpcMeta, GrpcTokenBalance, GrpcTxInfo};
use pb::geyser::SubscribeUpdateTransactionInfo;
use pb::solana::storage::confirmed_block::TokenBalance;

fn tb(b: &TokenBalance) -> GrpcTokenBalance {
    GrpcTokenBalance {
        account_index: b.account_index,
        mint: b.mint.clone(),
        owner: b.owner.clone(),
        ui_token_amount: b
            .ui_token_amount
            .as_ref()
            .map(|u| (u.amount.clone(), u.decimals)),
    }
}

/// The decoded protobuf update -> the parser's input (same fields convert.ts reads from the Node client's objects).
pub fn info_from_proto(t: &SubscribeUpdateTransactionInfo) -> GrpcTxInfo {
    let message = t
        .transaction
        .as_ref()
        .and_then(|x| x.message.as_ref())
        .map(|m| GrpcMessage {
            num_required_signatures: m.header.as_ref().map(|h| h.num_required_signatures),
            account_keys: m.account_keys.clone(),
            instructions: m.instructions.iter().map(|i| i.program_id_index).collect(),
        });
    let meta = t.meta.as_ref().map(|m| GrpcMeta {
        err: m.err.as_ref().map(|e| e.err.clone()),
        fee: m.fee,
        pre_balances: m.pre_balances.clone(),
        post_balances: m.post_balances.clone(),
        inner_instructions: m
            .inner_instructions
            .iter()
            .map(|ii| ii.instructions.iter().map(|i| i.program_id_index).collect())
            .collect(),
        pre_token_balances: m.pre_token_balances.iter().map(tb).collect(),
        post_token_balances: m.post_token_balances.iter().map(tb).collect(),
        loaded_writable_addresses: m.loaded_writable_addresses.clone(),
        loaded_readonly_addresses: m.loaded_readonly_addresses.clone(),
    });
    GrpcTxInfo {
        signature: t.signature.clone(),
        is_vote: t.is_vote,
        message,
        meta,
    }
}

/// GrpcTxInfo -> protobuf (fixtures to wire bytes, for the decode benchmark and the round-trip test).
pub fn proto_from_info(i: &GrpcTxInfo) -> SubscribeUpdateTransactionInfo {
    use pb::solana::storage::confirmed_block as cb;
    let tbp = |b: &GrpcTokenBalance| cb::TokenBalance {
        account_index: b.account_index,
        mint: b.mint.clone(),
        owner: b.owner.clone(),
        program_id: String::new(),
        ui_token_amount: b.ui_token_amount.as_ref().map(|(a, d)| cb::UiTokenAmount {
            ui_amount: 0.0,
            decimals: *d,
            amount: a.clone(),
            ui_amount_string: String::new(),
        }),
    };
    SubscribeUpdateTransactionInfo {
        signature: i.signature.clone(),
        is_vote: i.is_vote,
        index: 0,
        transaction: i.message.as_ref().map(|m| cb::Transaction {
            signatures: vec![i.signature.clone()],
            message: Some(cb::Message {
                header: m.num_required_signatures.map(|n| cb::MessageHeader {
                    num_required_signatures: n,
                    ..Default::default()
                }),
                account_keys: m.account_keys.clone(),
                instructions: m
                    .instructions
                    .iter()
                    .map(|p| cb::CompiledInstruction {
                        program_id_index: *p,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            }),
        }),
        meta: i.meta.as_ref().map(|m| cb::TransactionStatusMeta {
            err: m
                .err
                .as_ref()
                .map(|e| cb::TransactionError { err: e.clone() }),
            fee: m.fee,
            pre_balances: m.pre_balances.clone(),
            post_balances: m.post_balances.clone(),
            inner_instructions: m
                .inner_instructions
                .iter()
                .enumerate()
                .map(|(n, ii)| cb::InnerInstructions {
                    index: n as u32,
                    instructions: ii
                        .iter()
                        .map(|p| cb::InnerInstruction {
                            program_id_index: *p,
                            ..Default::default()
                        })
                        .collect(),
                })
                .collect(),
            pre_token_balances: m.pre_token_balances.iter().map(tbp).collect(),
            post_token_balances: m.post_token_balances.iter().map(tbp).collect(),
            loaded_writable_addresses: m.loaded_writable_addresses.clone(),
            loaded_readonly_addresses: m.loaded_readonly_addresses.clone(),
            ..Default::default()
        }),
    }
}
