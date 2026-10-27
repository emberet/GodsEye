/**
 * The fixture / replay format shared with the Rust ingest service (rust/ingest): a gRPC transaction update as JSON,
 * bytes written as base58 (errors as hex). One object per line. Used by the golden tests that prove the Rust parser
 * matches this one, by both parse benchmarks, and by `ge-ingest` replay mode.
 */
import bs58 from "bs58";
import type { GrpcTxInfo } from "./convert";

interface FxIx {
  programIdIndex: number;
}
interface FxTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount?: { amount: string; decimals: number };
}

export interface FixtureTx {
  name?: string;
  slot: number;
  receivedAtMs: number;
  /** SOL's USD price to parse with (stands in for market/solprice.ts); null = unknown. */
  solUsd: number | null;
  info: {
    signature: string;
    isVote: boolean;
    transaction?: { message?: { header?: { numRequiredSignatures: number }; accountKeys: string[]; instructions: FxIx[] } };
    meta?: {
      err?: { err: string };
      fee: string;
      preBalances: string[];
      postBalances: string[];
      innerInstructions: { instructions: FxIx[] }[];
      preTokenBalances: FxTokenBalance[];
      postTokenBalances: FxTokenBalance[];
      loadedWritableAddresses: string[];
      loadedReadonlyAddresses: string[];
    };
  };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function fixtureToGrpc(fx: FixtureTx): GrpcTxInfo {
  const i = fx.info;
  const m = i.transaction?.message;
  const meta = i.meta;
  return {
    signature: bs58.decode(i.signature),
    isVote: i.isVote,
    transaction: m
      ? { message: { header: m.header, accountKeys: m.accountKeys.map((k) => bs58.decode(k)), instructions: m.instructions.map((x) => ({ programIdIndex: x.programIdIndex })) } }
      : i.transaction ? {} : undefined,
    meta: meta
      ? {
          err: meta.err ? { err: new Uint8Array(Buffer.from(meta.err.err, "hex")) } : undefined,
          fee: meta.fee,
          preBalances: meta.preBalances,
          postBalances: meta.postBalances,
          innerInstructions: meta.innerInstructions,
          preTokenBalances: meta.preTokenBalances,
          postTokenBalances: meta.postTokenBalances,
          loadedWritableAddresses: meta.loadedWritableAddresses.map((k) => bs58.decode(k)),
          loadedReadonlyAddresses: meta.loadedReadonlyAddresses.map((k) => bs58.decode(k)),
        }
      : undefined,
  };
}

export function grpcToFixture(info: GrpcTxInfo, slot: number, receivedAtMs: number, solUsd: number | null, name?: string): FixtureTx {
  const m = info.transaction?.message;
  const meta = info.meta;
  return {
    ...(name ? { name } : {}),
    slot,
    receivedAtMs,
    solUsd,
    info: {
      signature: bs58.encode(info.signature),
      isVote: info.isVote,
      ...(info.transaction
        ? { transaction: m ? { message: { ...(m.header ? { header: m.header } : {}), accountKeys: m.accountKeys.map((k) => bs58.encode(k)), instructions: m.instructions } } : {} }
        : {}),
      ...(meta
        ? {
            meta: {
              ...(meta.err ? { err: { err: hex(meta.err.err) } } : {}),
              fee: meta.fee,
              preBalances: meta.preBalances,
              postBalances: meta.postBalances,
              innerInstructions: meta.innerInstructions,
              preTokenBalances: meta.preTokenBalances,
              postTokenBalances: meta.postTokenBalances,
              loadedWritableAddresses: meta.loadedWritableAddresses.map((k) => bs58.encode(k)),
              loadedReadonlyAddresses: meta.loadedReadonlyAddresses.map((k) => bs58.encode(k)),
            },
          }
        : {}),
    },
  };
}
