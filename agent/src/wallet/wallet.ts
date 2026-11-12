/**
 * GodsEye's own Solana wallet (the one that places copy trades), saved to
 * data/wallet/godseye-keypair.json (same format as the Solana CLI).
 * A new one is made only in paper mode or by "npm run wallet". With COPY_MODE=real a missing key file refuses to
 * start: there it means a wrong path or a lost key, and a fresh, empty wallet would hide that.
 *
 * ⚠️ That file IS the wallet. Anyone with it controls the funds.
 *    It is git-ignored. Back it up somewhere safe and never share it.
 */
import fs from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { dataPath, type DB, envStr, ownerOnly, setMeta } from "@godseye/shared";
import { config } from "../config";
import { withTimeout } from "../jobs";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../market/mint-profile";
import { copyConnection } from "../rpc";

export function walletFile(): string {
  const custom = envStr("AGENT_KEYPAIR_PATH");
  if (custom) return custom;
  // Wallets created before the GodsEye rename keep their original file name — never move a key file.
  const legacy = dataPath("wallet", "cowbot-keypair.json");
  return fs.existsSync(legacy) ? legacy : dataPath("wallet", "godseye-keypair.json");
}

/**
 * Reads the key file. With none there it makes a new wallet when `create` allows it, and refuses otherwise.
 * It never writes over a file that exists. (The path is a parameter so a test can use a throwaway file; the agent's
 * own key only ever goes through loadOrCreateWallet.)
 */
export function readOrCreateKeypair(file: string, create: boolean): { keypair: Keypair; created: boolean } {
  if (fs.existsSync(file)) return { keypair: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))), created: false };
  if (!create) {
    throw new Error(`No wallet key at ${file}. COPY_MODE=real never makes a new wallet: put the key file back or fix AGENT_KEYPAIR_PATH. ("npm run wallet" makes a new, empty one.)`);
  }
  const keypair = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600, flag: "wx" });
  return { keypair, created: true };
}

/**
 * The agent's wallet. With `real` (the default under COPY_MODE=real) it is never created, and a key file that other
 * users on this machine can read, and that can't be locked from here, refuses to start. Problems go to the console
 * only, never to the public feed.
 */
export function loadOrCreateWallet(db?: DB, real: boolean = config.copyMode === "real"): { keypair: Keypair; created: boolean } {
  if (process.env.GODSEYE_TEST === "1") throw new Error("Tests must never load or create the agent wallet.");
  const file = walletFile();
  const { keypair, created } = readOrCreateKeypair(file, !real);
  const lock = ownerOnly(file);
  if (lock === "tightened") console.warn("🔒 The wallet key file could be read by other users on this machine. Fixed: only its owner can read it now.");
  if (lock === "open") {
    const problem = `The wallet key file can be read by other users on this machine, and that can't be changed from here. As the file's owner, run: chmod 600 "${file}"`;
    if (real) throw new Error(problem);
    console.warn(`⚠️  ${problem}`);
  }
  if (db) {
    setMeta(db, "wallet_pubkey", keypair.publicKey.toBase58());
    if (created) setMeta(db, "wallet_created_at", new Date().toISOString());
  }
  return { keypair, created };
}

/** A wallet read the node hasn't answered by now fails, like any other read that failed: callers never wait on a hung node. */
const READ_MS = 20_000;

/** Tokens of `mint` held by `owner`, in UI units (both token programs). */
export async function walletTokenBalance(owner: PublicKey, mint: string): Promise<number> {
  const res = await withTimeout(copyConnection().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }), READ_MS, "token balance");
  return res.value.reduce((s, a) => s + Number((a.account.data.parsed as { info: { tokenAmount: { uiAmount: number | null } } }).info.tokenAmount.uiAmount ?? 0), 0);
}

/** Every token `owner` holds, by mint, in UI units (both token programs; empty accounts left out). */
export async function walletHoldings(owner: PublicKey): Promise<Map<string, number>> {
  const held = new Map<string, number>();
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await withTimeout(copyConnection().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(program) }), READ_MS, "wallet holdings");
    for (const a of res.value) {
      const { mint, tokenAmount } = (a.account.data.parsed as { info: { mint: string; tokenAmount: { uiAmount: number | null } } }).info;
      const amount = Number(tokenAmount.uiAmount ?? 0);
      if (amount > 0) held.set(mint, (held.get(mint) ?? 0) + amount);
    }
  }
  return held;
}

export async function walletBalanceSol(pubkey: PublicKey): Promise<number> {
  return (await withTimeout(copyConnection().getBalance(pubkey), READ_MS, "wallet balance")) / LAMPORTS_PER_SOL;
}
