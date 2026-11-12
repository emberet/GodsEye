/**
 * `npm run creator` — the creator-rewards switch for the agent's own pump.fun coin, for the owner's console (never the feed).
 * `npm run creator -- split <mint>` — shows the one-time split pump.fun will lock for the coin: CREATOR_TRADING_SHARE
 *   (30%) to the agent's wallet, the rest to CREATOR_PAYOUT_WALLET. Builds and simulates it; signs nothing.
 * `npm run creator -- split <mint> --confirm` — sets it. PERMANENT: pump.fun never lets it change again.
 * Run it after launching the coin from the agent's wallet. Addresses are never printed.
 */
import { PublicKey } from "@solana/web3.js";
import { getMeta, openDb, setMeta } from "@godseye/shared";
import { config } from "../config";
import { SET_ASIDE_KEY } from "../copy/risk";
import { pumpClient, splitInstructions, walletSender } from "../creator/pump";
import { MINT_KEY, ownCoin, rewardsCheck, splitOf } from "../creator/rewards";
import { copyConnection } from "../rpc";
import { loadOrCreateWallet } from "../wallet/wallet";

/** A split costs the agent its fees and the config account's rent, nothing more. */
const SPLIT_COST_LAMPORTS = -10_000_000n;

const db = openDb();
const [cmd, mintArg, flag] = process.argv.slice(2);
const conn = copyConnection();
const { keypair } = loadOrCreateWallet(undefined, true);
const wallet = keypair.publicKey;
const pct = (bps: number) => `${bps / 100}%`;

async function status(): Promise<void> {
  const mint = ownCoin(db, config);
  console.log(`Creator rewards: CREATOR_REWARDS=${config.creatorRewards} · payout wallet ${config.creatorPayoutWallet ? "set" : "NOT set"} · coin ${mint ? "known" : "not launched / not set"}`);
  const client = await pumpClient(conn);
  if (mint) {
    const sharing = await client.sharingConfig(new PublicKey(mint));
    if (!sharing) console.log("  pump.fun split: none yet (the agent claims as the creator and pays the owner's share on).");
    else if (sharing.editable) console.log("  pump.fun split: created but not set yet. Set it once: npm run creator -- split <mint>");
    else {
      const s = splitOf(sharing.shareholders, wallet.toBase58(), config.creatorPayoutWallet || null, config.creatorTradingShare);
      console.log(`  pump.fun split (locked): agent ${pct(s.agentBps)}${s.payoutBps === null ? "" : ` · payout wallet ${pct(s.payoutBps)}`} · ${sharing.shareholders.length} shareholder(s)${s.matches ? "" : " · DIFFERS from the owner's split"}`);
      const d = await client.distributable(new PublicKey(mint), wallet);
      console.log(`  waiting to be paid out: ${(Number(d.lamports) / 1e9).toFixed(4)} SOL${d.can ? "" : " (not enough to pay out yet)"}`);
    }
  }
  const vault = await client.creatorVaultLamports(wallet);
  console.log(`  claimable by the agent as creator: ${(Number(vault) / 1e9).toFixed(4)} SOL · set aside for the owner: ${Number(getMeta(db, SET_ASIDE_KEY) ?? 0).toFixed(4)} SOL`);
}

async function split(): Promise<void> {
  if (!mintArg) throw new Error("Usage: npm run creator -- split <mint> [--confirm]");
  if (!config.creatorPayoutWallet) throw new Error("Set CREATOR_PAYOUT_WALLET in .env first: it gets the owner's share for good.");
  const mint = new PublicKey(mintArg);
  const payout = new PublicKey(config.creatorPayoutWallet);
  if (payout.equals(wallet)) throw new Error("CREATOR_PAYOUT_WALLET is the agent's own wallet.");
  const agentBps = Math.round(config.creatorTradingShare * 10_000);
  if (!(agentBps > 0 && agentBps < 10_000)) throw new Error("CREATOR_TRADING_SHARE must be between 0 and 1.");
  const shares = [{ address: wallet, shareBps: agentBps }, { address: payout, shareBps: 10_000 - agentBps }];
  const steps = await splitInstructions(conn, wallet, mint, shares);
  const confirm = flag === "--confirm";
  const sender = walletSender(conn, wallet, keypair);
  const check = (tx: Parameters<typeof rewardsCheck>[0]) => rewardsCheck(tx, wallet, null, 0n);
  console.log(`The split to lock: agent's wallet ${pct(agentBps)}, payout wallet ${pct(10_000 - agentBps)}. pump.fun never lets it change again.`);
  if (!steps.exists) {
    await sender.run(await steps.create(), check, SPLIT_COST_LAMPORTS, !confirm);
    console.log(confirm ? "Step 1 of 2 done: the coin's sharing config is created." : "Step 1 of 2 (create the sharing config): built and simulated, it passes.");
    if (!confirm) return void console.log("Step 2 sets the shares; it can only be built once step 1 is on-chain. Run again with --confirm to do both.");
  }
  await sender.run(await steps.update(), check, SPLIT_COST_LAMPORTS, !confirm);
  if (!confirm) return void console.log("Step 2 (set the shares): built and simulated, it passes. Run again with --confirm to lock it.");
  setMeta(db, MINT_KEY, mint.toBase58());
  const after = await (await pumpClient(conn)).sharingConfig(mint);
  const s = after ? splitOf(after.shareholders, wallet.toBase58(), payout.toBase58(), config.creatorTradingShare) : null;
  console.log(s?.matches ? "Done: the split is set and locked. The creator-rewards job pays it out (CREATOR_REWARDS=on)." : "The split was sent, but reading it back doesn't show the expected shares: check with npm run creator.");
}

(cmd === "split" ? split() : status()).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
