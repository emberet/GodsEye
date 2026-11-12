/**
 * CREATOR REWARDS — the switch for GodsEye's own pump.fun coin, launched from the agent's wallet.
 *
 * The owner's split: 30% of the coin's creator rewards to the agent's wallet to trade with, 70% to the owner's wallet.
 * pump.fun can split the rewards itself ("fee sharing"): set once, after the launch, and then locked for good
 * (`npm run creator -- split <mint>`). Each run (CREATOR_CRON, twice an hour) this job:
 *   - with fee sharing set: pays out what has built up ("distribute", which anyone may run). pump.fun sends each share
 *     straight to its wallet, so the agent never holds the owner's money. The split is checked against the owner's.
 *   - without it, when the agent's wallet is the coin's creator: claims the rewards itself and sends 70% to
 *     CREATOR_PAYOUT_WALLET in the same transaction. With no payout wallet set, the 70% stays in the wallet, set aside
 *     and never traded (copy/risk.ts leaves it out), and is paid with the next claim once there is one.
 * With no coin launched there is nothing to claim and nothing happens: the job arms itself.
 * CREATOR_REWARDS: off (default) · dry (works it out and simulates it on the live chain; signs nothing) · on.
 *
 * Before signing, its own check: the agent is the only signer and pays the fee; only pump.fun's programs and the usual
 * plumbing; a SOL transfer only to the payout wallet and never above the owner's share; and the simulation must show the
 * agent's SOL going up by at least its own share (a distribute: not down by more than the fee).
 * Every claim and payout goes into wallet_flows (the agent's share buys units like a deposit, so it never counts as
 * trading profit) and into the proof ledger. The agent never copy-trades its own coin (ownCoin, used by the engine).
 * Nothing it says carries an address or a signature.
 */
import { PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { commitProof, type DB, getMeta, nowIso, setMeta } from "@godseye/shared";
import type { Config } from "../config";
import { SET_ASIDE_KEY } from "../copy/risk";
import { say } from "../log";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEES_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const PUMP_PROGRAMS = new Set([PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM]);
const SYSTEM = SystemProgram.programId.toBase58();
const PLUMBING = new Set([
  SYSTEM,
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);
/** Network fees with room to spare: what a distribute may cost the agent. */
export const FEE_ROOM_LAMPORTS = 50_000n;
/** The mint `npm run creator -- split` remembers. */
export const MINT_KEY = "creator_mint";
const NOTE_KEY = "creator_note";

const sol = (lamports: bigint | number): string => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

/** The coin's mint, if one is known. */
export function ownCoin(db: DB, c: Pick<Config, "creatorMint">): string | null {
  return c.creatorMint || getMeta(db, MINT_KEY) || null;
}

/** What pump.fun is asked; the real one wraps the official SDK (./pump.ts), tests pass a fake. */
export interface PumpClient {
  /** SOL (lamports) `creator` can collect from both pump programs' creator vaults. */
  creatorVaultLamports(creator: PublicKey): Promise<bigint>;
  /** The coin's fee-sharing config; null when it has none. `editable`: not configured yet (it locks once set). */
  sharingConfig(mint: PublicKey): Promise<{ shareholders: { address: string; shareBps: number }[]; editable: boolean } | null>;
  /** What a distribute would pay out now (lamports), and whether it can run. */
  distributable(mint: PublicKey, payer: PublicKey): Promise<{ lamports: bigint; can: boolean }>;
  distributeInstructions(mint: PublicKey, payer: PublicKey): Promise<TransactionInstruction[]>;
  /** Collects `creator`'s rewards (sweeping what is still on the coin's curve first, when the mint is known). */
  collectInstructions(creator: PublicKey, mint: PublicKey | null): Promise<TransactionInstruction[]>;
}

/** Builds, checks, simulates and (unless dry) sends a transaction from the agent's wallet. The real one is in ./pump.ts. */
export interface RewardsSender {
  /**
   * `check` is run on the built transaction; `minGainLamports` is the least the agent's SOL may change by in the
   * simulation (negative = it may go down that much). Throws with the reason when either fails. Dry: stops after the
   * simulation and returns no signature.
   */
  run(ixs: TransactionInstruction[], check: (tx: VersionedTransaction) => string | null, minGainLamports: bigint, dry: boolean): Promise<{ signature: string; slot: number } | null>;
}

/** How the agent and the owner fare under a sharing config (bps out of 10,000). Pure. */
export function splitOf(shareholders: { address: string; shareBps: number }[], agent: string, payout: string | null, tradingShare: number) {
  const agentBps = shareholders.filter((s) => s.address === agent).reduce((n, s) => n + s.shareBps, 0);
  const payoutBps = payout ? shareholders.filter((s) => s.address === payout).reduce((n, s) => n + s.shareBps, 0) : null;
  const want = Math.round(tradingShare * 10_000);
  return { agentBps, payoutBps, matches: agentBps === want && (payoutBps === null || payoutBps === 10_000 - want) };
}

/** A claim of `claimLamports`, split: what goes to the payout wallet now, what the agent keeps, what is set aside. Pure. */
export function planCollect(claimLamports: bigint, tradingShare: number, hasPayout: boolean, setAsideLamports: bigint) {
  const keep = (claimLamports * BigInt(Math.round(tradingShare * 10_000))) / 10_000n;
  const owner = claimLamports - keep;
  return hasPayout ? { pay: owner + setAsideLamports, keep, setAside: -setAsideLamports } : { pay: 0n, keep, setAside: owner };
}

/**
 * The job's own check on a transaction, before it is signed. Returns why it is unsafe, or null. Pure.
 * `payout`/`maxPayLamports`: the only wallet a SOL transfer may go to, and the most it may send there in all.
 */
export function rewardsCheck(tx: VersionedTransaction, wallet: PublicKey, payout: PublicKey | null, maxPayLamports: bigint): string | null {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0]?.equals(wallet)) return "the agent is not the fee payer";
  if (msg.header.numRequiredSignatures !== 1) return `needs ${msg.header.numRequiredSignatures} signatures (expected only the agent's)`;
  let paid = 0n;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex]?.toBase58();
    if (!program || !(PUMP_PROGRAMS.has(program) || PLUMBING.has(program))) return "calls a program other than pump.fun's and the usual plumbing";
    if (program !== SYSTEM) continue;
    const data = Buffer.from(ix.data);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) return "uses a system instruction other than a transfer";
    const to = keys[ix.accountKeyIndexes[1]];
    if (!payout || !to?.equals(payout)) return "sends SOL somewhere other than the payout wallet";
    paid += data.readBigUInt64LE(4);
  }
  if (paid > maxPayLamports) return `sends ${sol(paid)} to the payout wallet, more than the owner's ${sol(maxPayLamports)}`;
  return null;
}

/** Says `text` at most once a day per `key` (a repeated note about the same state would flood the feed). */
function noteDaily(db: DB, key: string, text: string, level: "info" | "warn" = "info"): void {
  const day = new Date().toISOString().slice(0, 10);
  let seen: Record<string, string> = {};
  try {
    seen = JSON.parse(getMeta(db, NOTE_KEY) || "{}") as Record<string, string>;
  } catch {
    seen = {};
  }
  if (seen[key] === day) return;
  setMeta(db, NOTE_KEY, JSON.stringify({ ...seen, [key]: day }));
  say(level, text);
}

export interface RewardsDeps {
  wallet: PublicKey;
  client: PumpClient;
  sender: RewardsSender;
}

export type RewardsOutcome = "off" | "nothing" | "dry" | "distributed" | "claimed";

/** One run of the job. Throws on a read or a check that fails (the job runner logs it); nothing is sent then. */
export async function runRewards(db: DB, c: Config, deps: RewardsDeps): Promise<RewardsOutcome> {
  if (c.creatorRewards === "off") return "off";
  const dry = c.creatorRewards === "dry";
  const agent = deps.wallet.toBase58();
  const payout = c.creatorPayoutWallet ? new PublicKey(c.creatorPayoutWallet) : null;
  if (payout?.equals(deps.wallet)) throw new Error("CREATOR_PAYOUT_WALLET is the agent's own wallet");
  const minLamports = BigInt(Math.round(c.creatorMinClaimSol * 1e9));
  const mintText = ownCoin(db, c);
  const mint = mintText ? new PublicKey(mintText) : null;

  // 1) pump.fun's own split, when the coin has one.
  const config = mint ? await deps.client.sharingConfig(mint) : null;
  if (mint && config) {
    if (config.editable) noteDaily(db, "unset", "Creator rewards: the coin's fee split isn't set yet (it can be set once, then it is locked): npm run creator -- split.");
    else {
      const split = splitOf(config.shareholders, agent, payout?.toBase58() ?? null, c.creatorTradingShare);
      if (!split.matches)
        noteDaily(db, "split", `Creator rewards: pump.fun's split gives the agent ${split.agentBps / 100}%${split.payoutBps === null ? "" : ` and the payout wallet ${split.payoutBps / 100}%`}, not the owner's ${Math.round(c.creatorTradingShare * 100)}/${100 - Math.round(c.creatorTradingShare * 100)}. It is locked; payouts go on as set.`, "warn");
      const d = await deps.client.distributable(mint, deps.wallet);
      if (!d.can || d.lamports < minLamports) return "nothing";
      const ixs = await deps.client.distributeInstructions(mint, deps.wallet);
      const sent = await deps.sender.run(ixs, (tx) => rewardsCheck(tx, deps.wallet, null, 0n), -FEE_ROOM_LAMPORTS, dry);
      const share = (d.lamports * BigInt(split.agentBps)) / 10_000n;
      if (!sent) {
        say("info", `Creator rewards (dry): would pay out ${sol(d.lamports)} through pump.fun's split, ${sol(share)} of it to the agent. Simulated: it passes.`);
        return "dry";
      }
      // The agent's share lands in its wallet: the funding ledger records it as a creator claim from the chain.
      commitProof(db, "creator_distribute", { distributed_sol: Number(d.lamports) / 1e9, agent_share_sol: Number(share) / 1e9, at: nowIso() });
      say("info", `Creator rewards paid out through pump.fun's split: ${sol(d.lamports)}, ${sol(share)} of it to the agent (it buys units, it isn't trading profit).`);
      return "distributed";
    }
  }

  // 2) No split set: the agent's wallet collects as the coin's creator, and pays the owner's share on.
  const vault = await deps.client.creatorVaultLamports(deps.wallet);
  if (vault < minLamports) return "nothing";
  const held = BigInt(Math.round(Math.max(0, Number(getMeta(db, SET_ASIDE_KEY) ?? 0) || 0) * 1e9));
  const plan = planCollect(vault, c.creatorTradingShare, !!payout, held);
  const ixs = [...(await deps.client.collectInstructions(deps.wallet, mint))];
  if (payout && plan.pay > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: deps.wallet, toPubkey: payout, lamports: plan.pay }));
  // The agent's SOL must go up by what stays in the wallet (its share, plus or minus the set-aside), less fees and a
  // little slack (a claim a little below the read only lowers it).
  const stays = plan.keep + plan.setAside;
  const sent = await deps.sender.run(ixs, (tx) => rewardsCheck(tx, deps.wallet, payout, plan.pay), stays - FEE_ROOM_LAMPORTS - stays / 100n, dry);
  if (!sent) {
    say("info", `Creator rewards (dry): would claim ${sol(vault)}: ${sol(plan.keep)} to trade with, ${payout ? `${sol(plan.pay)} to the payout wallet` : `${sol(plan.setAside)} set aside (no payout wallet yet)`}. Simulated: it passes.`);
    return "dry";
  }
  db.transaction(() => {
    const flow = db.prepare("INSERT OR IGNORE INTO wallet_flows (signature, slot, ts, kind, sol, units, expected, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)");
    // The agent's share buys units (priced at the next risk look); the payout moves SOL that was never its to trade.
    flow.run(sent.signature, sent.slot, nowIso(), "creator_claim", Number(plan.keep) / 1e9, null, nowIso());
    if (plan.pay > 0n) flow.run(`${sent.signature}#payout`, sent.slot, nowIso(), "payout", -Number(plan.pay) / 1e9, 0, nowIso());
    setMeta(db, SET_ASIDE_KEY, Math.max(0, Number(held + plan.setAside) / 1e9));
    commitProof(db, "creator_claim", { claimed_sol: Number(vault) / 1e9, kept_sol: Number(plan.keep) / 1e9, paid_sol: Number(plan.pay) / 1e9, set_aside_sol: Number(plan.setAside) / 1e9, at: nowIso() });
  })();
  say("info", `Creator rewards claimed: ${sol(vault)}. ${sol(plan.keep)} to trade with (it buys units, it isn't trading profit); ${payout ? `${sol(plan.pay)} sent to the owner's wallet` : `${sol(plan.setAside)} set aside for the owner until a payout wallet is set`}.`);
  return "claimed";
}
