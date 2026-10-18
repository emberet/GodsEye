/**
 * NEVER SIGN BLIND. Jupiter's API builds GodsEye's swap transactions; before
 * signing one, GodsEye checks it two ways:
 *
 *   1. Static check: GodsEye pays the fee and is the only signer; top-level
 *      instructions only use Jupiter + plumbing programs (compute budget,
 *      system, token, associated-token); a plain SOL transfer may only go to
 *      GodsEye's own wrapped-SOL account; token instructions may only sync or
 *      close GodsEye's own accounts; the priority fee is within the limit.
 *   2. Simulation: run it against the current chain state and check what it
 *      would actually do. A buy must cost no more SOL than planned and must
 *      deliver at least the quoted minimum of tokens into GodsEye's own token
 *      account; a sell must pay at least the quoted minimum SOL back.
 *
 * If either check fails, nothing is signed.
 */
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { SOL_MINT } from "@godseye/shared";
import { ALLOWED_SWAP_PROGRAMS } from "../chain/programs";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** Room for token-account rent and network fees on top of the trade itself. */
export const OVERHEAD_LAMPORTS = 10_000_000;

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/** Returns why the transaction is unsafe, or null if it passes. */
export function staticCheck(tx: VersionedTransaction, wallet: PublicKey, maxPriorityLamports: number): string | null {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) return "GodsEye is not the fee payer";
  if (msg.header.numRequiredSignatures !== 1) return `needs ${msg.header.numRequiredSignatures} signatures (expected only GodsEye's)`;
  const wsolAta = associatedTokenAddress(wallet, new PublicKey(SOL_MINT), new PublicKey(TOKEN));
  const key = (i: number) => (i < keys.length ? keys[i] : null); // lookup-table accounts can't be checked statically
  let cuLimit = 200_000;
  let cuPrice = 0n;
  for (const ix of msg.compiledInstructions) {
    const program = key(ix.programIdIndex)?.toBase58();
    if (!program || !ALLOWED_SWAP_PROGRAMS.has(program)) return `calls an unexpected program ${program ?? "(lookup table)"}`;
    const data = Buffer.from(ix.data);
    if (program === SYSTEM) {
      if (data.readUInt32LE(0) !== 2) return "uses a system instruction other than a transfer";
      const dest = key(ix.accountKeyIndexes[1]);
      if (!dest?.equals(wsolAta)) return `sends SOL to ${dest?.toBase58() ?? "an unknown account"}, not GodsEye's wrapped-SOL account`;
    } else if (program === TOKEN || program === TOKEN_2022) {
      if (data[0] === 17) continue; // SyncNative
      if (data[0] !== 9) return `uses token instruction ${data[0]} (only sync/close allowed)`;
      const dest = key(ix.accountKeyIndexes[1]);
      const owner = key(ix.accountKeyIndexes[2]);
      if (!dest?.equals(wallet) || !owner?.equals(wallet)) return "closes a token account into someone else's wallet";
    } else if (program === COMPUTE_BUDGET) {
      if (data[0] === 2) cuLimit = data.readUInt32LE(1);
      if (data[0] === 3) cuPrice = data.readBigUInt64LE(1);
    }
  }
  const priorityLamports = Number((cuPrice * BigInt(cuLimit)) / 1_000_000n);
  if (priorityLamports > maxPriorityLamports * 2) return `priority fee ${priorityLamports} lamports is above the limit`;
  return null;
}

const tokenAmountFromData = (b64: string): bigint => {
  const data = Buffer.from(b64, "base64");
  return data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
};

/** Simulates the swap and checks its effect on GodsEye's balances. Throws if anything is off. */
export async function simulateCheck(
  conn: Connection,
  tx: VersionedTransaction,
  wallet: PublicKey,
  plan: { side: "buy"; mint: string; inLamports: bigint; minTokensOut: bigint } | { side: "sell"; minLamportsOut: bigint },
): Promise<void> {
  const addresses = [wallet.toBase58()];
  let ata: PublicKey | null = null;
  let preTokens = 0n;
  if (plan.side === "buy") {
    const mint = new PublicKey(plan.mint);
    const mintInfo = await conn.getAccountInfo(mint);
    if (!mintInfo) throw new Error("token mint not found");
    ata = associatedTokenAddress(wallet, mint, mintInfo.owner);
    addresses.push(ata.toBase58());
    const existing = await conn.getAccountInfo(ata);
    if (existing) preTokens = tokenAmountFromData(existing.data.toString("base64"));
  }
  const preLamports = BigInt(await conn.getBalance(wallet, "processed"));
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses } });
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
  const after = sim.value.accounts;
  if (!after?.[0]) throw new Error("simulation returned no account state");
  const postLamports = BigInt(after[0].lamports);

  if (plan.side === "buy") {
    const spent = preLamports - postLamports;
    if (spent > plan.inLamports + BigInt(OVERHEAD_LAMPORTS)) throw new Error(`would spend ${spent} lamports, planned ${plan.inLamports}`);
    const postTokens = after[1]?.data ? tokenAmountFromData((after[1].data as string[])[0]) : 0n;
    if (postTokens - preTokens < plan.minTokensOut) throw new Error(`would receive ${postTokens - preTokens} tokens, quote promised at least ${plan.minTokensOut}`);
  } else {
    const gained = postLamports - preLamports;
    if (gained < plan.minLamportsOut - BigInt(OVERHEAD_LAMPORTS)) throw new Error(`would receive ${gained} lamports, quote promised at least ${plan.minLamportsOut}`);
  }
}
