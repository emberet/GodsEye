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
import { connection } from "../rpc";

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

/** Tokens of `mint` held by `owner`, in UI units (both token programs). */
export async function walletTokenBalance(owner: PublicKey, mint: string): Promise<number> {
  const res = await connection().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return res.value.reduce((s, a) => s + Number((a.account.data.parsed as { info: { tokenAmount: { uiAmount: number | null } } }).info.tokenAmount.uiAmount ?? 0), 0);
}

export async function walletBalanceSol(pubkey: PublicKey): Promise<number> {
  return (await connection().getBalance(pubkey)) / LAMPORTS_PER_SOL;
}
