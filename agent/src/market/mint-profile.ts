/**
 * MINT PROFILE — what a token's contract does to a trade.
 *
 * A token is a mint account owned by the SPL Token program or by Token-2022. Token-2022 mints can carry extensions that
 * change what a transfer does, and a swap is a transfer. This turns the parsed mint (what rugcheck.ts reads once per
 * token) into the facts a trade depends on:
 *   • the transfer fee — taken from the amount RECEIVED, so a pool or wallet gets less than was sent, in both directions
 *     (fee = min(ceil(amount × bps / 10,000), maximum fee)); changing it takes effect two epochs after it is set;
 *   • things that can stop or take tokens: a transfer hook (arbitrary code on every transfer), a permanent delegate (can
 *     move or burn tokens out of any holder's account), pausable transfers, new accounts starting frozen, non-transferable;
 *   • authorities that can still change the rules: mint, freeze, transfer-fee config, mint-close, metadata update.
 * Pure: parsed mint in, profile out. Layout and semantics: research_notes/Pool and contract intelligence/token_and_program_contracts.md.
 */

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** A mint as RPC `getAccountInfo` with `jsonParsed` returns it (`owner` is the token program). */
export interface ParsedMint {
  tokenProgram?: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply?: string | null;
  decimals?: number | null;
  extensions: { extension: string; state?: Record<string, unknown> }[];
}

export interface TransferFee {
  epoch: number;
  /** Cap on the fee for one transfer, in raw token units. */
  maximumFee: number;
  bps: number;
}

export interface TransferFeeConfig {
  older: TransferFee;
  newer: TransferFee;
  /** Whoever can set a new fee (it applies two epochs later). null = fixed forever. */
  configAuthority: string | null;
  /** Whoever can collect the fees withheld in token accounts. */
  withdrawAuthority: string | null;
  withheld: number;
}

export interface MintProfile {
  program: "spl" | "token-2022" | "unknown";
  extensions: string[];
  transferFee: TransferFeeConfig | null;
  /** The hook program that runs on every transfer. */
  transferHook: string | null;
  permanentDelegate: string | null;
  pausable: boolean;
  defaultFrozen: boolean;
  nonTransferable: boolean;
  closeAuthority: string | null;
  confidentialTransfer: boolean;
  interestBearing: boolean;
  scaledUiAmount: boolean;
  /** Token-2022 metadata stored on the mint: who can change the name, symbol and picture (null = nobody; undefined = no such extension). */
  metadataUpdateAuthority: string | null | undefined;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

const asObj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const num = (x: unknown): number => {
  const n = typeof x === "string" ? Number(x) : (x as number);
  return Number.isFinite(n) ? n : 0;
};
const fee = (x: unknown): TransferFee => {
  const o = asObj(x);
  return { epoch: num(o.epoch), maximumFee: num(o.maximumFee), bps: num(o.transferFeeBasisPoints) };
};

export function profileMint(m: ParsedMint): MintProfile {
  const by = new Map<string, Record<string, unknown>>();
  for (const e of m.extensions ?? []) by.set(e.extension, asObj(e.state));
  const tf = by.get("transferFeeConfig");
  const hook = by.get("transferHook");
  const meta = by.get("tokenMetadata");
  return {
    program: m.tokenProgram === TOKEN_2022_PROGRAM ? "token-2022" : m.tokenProgram === TOKEN_PROGRAM ? "spl" : m.extensions?.length ? "token-2022" : "unknown",
    extensions: [...by.keys()],
    transferFee: tf
      ? { older: fee(tf.olderTransferFee), newer: fee(tf.newerTransferFee), configAuthority: str(tf.transferFeeConfigAuthority), withdrawAuthority: str(tf.withdrawWithheldAuthority), withheld: num(tf.withheldAmount) }
      : null,
    transferHook: hook ? str(hook.programId) : null,
    permanentDelegate: str(by.get("permanentDelegate")?.delegate),
    pausable: !!str(by.get("pausableConfig")?.authority),
    defaultFrozen: by.get("defaultAccountState")?.accountState === "frozen",
    nonTransferable: by.has("nonTransferable"),
    closeAuthority: str(by.get("mintCloseAuthority")?.closeAuthority),
    confidentialTransfer: by.has("confidentialTransferMint"),
    interestBearing: by.has("interestBearingConfig"),
    scaledUiAmount: by.has("scaledUiAmountConfig"),
    metadataUpdateAuthority: meta ? str(meta.updateAuthority) : undefined,
    mintAuthority: m.mintAuthority ?? null,
    freezeAuthority: m.freezeAuthority ?? null,
  };
}

/**
 * The fee in force. `newer` replaces `older` from its epoch on; without the current epoch the dearer of the two is
 * returned, which is the safe reading for a buyer.
 */
export function feeInForce(c: TransferFeeConfig, currentEpoch?: number): TransferFee {
  if (currentEpoch === undefined) return c.newer.bps >= c.older.bps ? c.newer : c.older;
  return currentEpoch >= c.newer.epoch ? c.newer : c.older;
}

/** Tokens withheld from one transfer of `amount` (raw units): min(ceil(amount × bps / 10,000), maximum fee). */
export function transferFeeOn(amount: number, f: TransferFee): number {
  if (!(amount > 0) || f.bps <= 0) return 0;
  return Math.min(Math.ceil((amount * f.bps) / 10_000), f.maximumFee);
}

/** What the receiver gets out of `amount` sent (raw units). */
export const receivedAfterFee = (amount: number, f: TransferFee): number => amount - transferFeeOn(amount, f);

/** A fee change that is already set but not yet in force (the fee will differ from today's). */
export const feeChangePending = (c: TransferFeeConfig, currentEpoch?: number): boolean => c.newer.bps !== c.older.bps && (currentEpoch === undefined || currentEpoch < c.newer.epoch);

export interface TraitFinding {
  severity: "block" | "warn";
  text: string;
}

/**
 * What in the mint can hurt someone who buys it, beyond the authorities rugcheck.ts already judges. `maxFeeBps` is the
 * transfer fee at or above which buying is refused (a fee that large is a tax on every exit).
 */
export function tradeTraits(p: MintProfile, opts: { maxFeeBps: number; currentEpoch?: number } = { maxFeeBps: 1000 }): TraitFinding[] {
  const out: TraitFinding[] = [];
  if (p.transferFee) {
    const f = feeInForce(p.transferFee, opts.currentEpoch);
    const pct = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`;
    if (f.bps >= opts.maxFeeBps) out.push({ severity: "block", text: `a ${pct(f.bps)} transfer fee is taken on every buy and sell` });
    else if (f.bps > 0) out.push({ severity: "warn", text: `charges a ${pct(f.bps)} transfer fee on every buy and sell (the pool receives less than is sent)` });
    if (feeChangePending(p.transferFee, opts.currentEpoch)) out.push({ severity: "warn", text: `its transfer fee is changing from ${pct(p.transferFee.older.bps)} to ${pct(p.transferFee.newer.bps)}` });
    if (p.transferFee.configAuthority) out.push({ severity: "warn", text: "someone can still change the transfer fee (it takes effect two epochs after they set it)" });
  }
  if (p.closeAuthority) out.push({ severity: "warn", text: "the mint can be closed by its authority" });
  if (p.nonTransferable) out.push({ severity: "block", text: "tokens can't be transferred (non-transferable)" });
  return out;
}
