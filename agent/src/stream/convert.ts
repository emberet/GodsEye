/**
 * Turns a gRPC transaction update (Shyft, Triton, Helius and QuickNode all speak
 * the same Yellowstone Geyser protocol) into the same shape parse.ts
 * reads from RPC "jsonParsed" transactions, so live and historical swaps go
 * through exactly the same parser.
 *
 * Account order matches Solana's: static keys, then lookup-table writable
 * addresses, then lookup-table read-only addresses.
 */
import bs58 from "bs58";
import type { TxLike } from "../chain/parse";

interface GrpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount?: { amount: string; decimals: number };
}

/** The fields of a gRPC SubscribeUpdateTransactionInfo GodsEye reads. */
export interface GrpcTxInfo {
  signature: Uint8Array;
  isVote: boolean;
  transaction?: {
    message?: {
      header?: { numRequiredSignatures: number };
      accountKeys: Uint8Array[];
      instructions: { programIdIndex: number }[];
    };
  };
  meta?: {
    err?: { err: Uint8Array };
    fee: string;
    preBalances: string[];
    postBalances: string[];
    innerInstructions: { instructions: { programIdIndex: number }[] }[];
    preTokenBalances: GrpcTokenBalance[];
    postTokenBalances: GrpcTokenBalance[];
    loadedWritableAddresses: Uint8Array[];
    loadedReadonlyAddresses: Uint8Array[];
  };
}

export interface Converted {
  tx: TxLike;
  signers: string[];
}

export function convertGrpcTx(info: GrpcTxInfo, slot: number, receivedAtMs: number): Converted | null {
  const msg = info.transaction?.message;
  const meta = info.meta;
  if (!msg || !meta || info.isVote) return null;
  const keys = [...msg.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map((k) => bs58.encode(k));
  const asKey = (s: string) => ({ pubkey: s });
  const prog = (i: number) => ({ programId: keys[i] ?? "" });
  const bal = (b: GrpcTokenBalance) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { amount: b.uiTokenAmount?.amount ?? "0", decimals: b.uiTokenAmount?.decimals ?? 0 },
  });
  const tx: TxLike = {
    slot,
    blockTime: Math.floor(receivedAtMs / 1000),
    meta: {
      err: meta.err && meta.err.err.length ? meta.err : null,
      fee: Number(meta.fee),
      preBalances: meta.preBalances.map(Number),
      postBalances: meta.postBalances.map(Number),
      preTokenBalances: meta.preTokenBalances.map(bal),
      postTokenBalances: meta.postTokenBalances.map(bal),
      innerInstructions: meta.innerInstructions.map((ii) => ({ instructions: ii.instructions.map((i) => prog(i.programIdIndex)) })),
    },
    transaction: {
      signatures: [bs58.encode(info.signature)],
      message: {
        accountKeys: keys.map(asKey),
        instructions: msg.instructions.map((i) => prog(i.programIdIndex)),
      },
    },
  };
  const n = msg.header?.numRequiredSignatures ?? 1;
  return { tx, signers: keys.slice(0, n) };
}
