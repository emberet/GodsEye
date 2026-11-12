/**
 * GodsEye's own Solana wallet (the one that places copy trades).
 * Created automatically the first time the agent runs and saved to
 * data/wallet/godseye-keypair.json (same format as the Solana CLI).
 *
 * ⚠️ That file IS the wallet. Anyone with it controls the funds.
 *    It is git-ignored. Back it up somewhere safe and never share it.
 */
import fs from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { dataPath, type DB, envStr, setMeta } from "@godseye/shared";
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

export function loadOrCreateWallet(db?: DB): { keypair: Keypair; created: boolean } {
  if (process.env.GODSEYE_TEST === "1") throw new Error("Tests must never load or create the agent wallet.");
  const file = walletFile();
  let keypair: Keypair;
  let created = false;
  if (fs.existsSync(file)) {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    created = true;
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
