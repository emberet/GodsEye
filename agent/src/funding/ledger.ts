/**
 * THE FUNDING LEDGER — every SOL movement of the agent's wallet that is not one of its trades (wallet_flows).
 *
 * Each minute (real mode, before the risk look) it reads the wallet's new transactions, oldest first, up to the slot of
 * the balance the risk look will use, and sorts each one:
 *   - one of the agent's own trades (its signature is on a copy_trades row): nothing to record, the trade has its row;
 *   - the agent's own housekeeping (closing empty token accounts for their rent): a trading cost, nothing to record;
 *   - a swap the agent didn't make: recorded as `swap`, without units (the wallet sweep adopts or settles the tokens);
 *   - SOL in from pump.fun's programs: the agent's share of its own coin's creator rewards (`creator_claim`);
 *   - SOL in: a `deposit`; SOL out: a `withdrawal`. Changes under DUST_SOL (spam, a failed transaction's fee) are left out.
 * The risk look (copy/risk.ts) then gives each deposit and withdrawal its units.
 *
 * Unexplained money fails safe. A withdrawal the owner didn't announce (`npm run funding -- expect <SOL>`) and above
 * FUNDING_OUTFLOW_PAUSE_SOL may be a drain: new buys are paused (sells go on) and the owner is told. `npm run resume`
 * starts buying again once they have looked. Nothing here goes on the public feed beyond amounts: no signature, no address.
 */
import { PublicKey } from "@solana/web3.js";
import { type DB, getMeta, nowIso, setMeta } from "@godseye/shared";
import { alert } from "../alerts";
import { fetchParsedOne } from "../chain/history";
import { parseSwaps, type TxLike } from "../chain/parse";
import { noteCopyRpc } from "../chain/rpc-budget";
import { withTimeout } from "../jobs";
import { say } from "../log";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../market/mint-profile";
import { PUMP_PROGRAMS } from "../creator/rewards";
import { copyConnection } from "../rpc";

/** An amount of SOL, unsigned. */
const amount = (n: number): string => `${n.toFixed(4)} SOL`;

/** SOL changes smaller than this are not funding (spam transfers, a failed transaction's fee). */
export const DUST_SOL = 0.001;
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const HOUSEKEEPING = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET, ATA_PROGRAM]);
/** Most transactions read in one pass (the rest wait for the next minute). */
const MAX_READS = 40;
const PAGE = 1000;
const MAX_PAGES = 5;
const READ_MS = 20_000;
const CURSOR_KEY = "funding_cursor";
/** An announced withdrawal: `npm run funding -- expect <SOL>` (good for a day). */
export const EXPECT_KEY = "funding_expect";
const EXPECT_SLACK_SOL = 0.01;

export type FlowKind = "deposit" | "withdrawal" | "swap" | "creator_claim";

/** What a transaction did to the wallet's SOL, apart from its own trades; null = nothing to record. Pure. */
export function classifyFlow(tx: TxLike, wallet: string): { kind: FlowKind; sol: number } | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;
  const sol = (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9;
  if (Math.abs(sol) < DUST_SOL) return null;
  const programs = tx.transaction.message.instructions.map((i) => i.programId.toString());
  // The wallet paid for it and it only touched token accounts: the agent closing empty ones for their rent.
  if (idx === 0 && programs.length > 0 && programs.every((p) => HOUSEKEEPING.has(p))) return null;
  if (!meta.err && parseSwaps(tx, wallet).length) return { kind: "swap", sol };
  // SOL from pump.fun that no swap explains: the agent's share of its own coin's creator rewards (creator/rewards.ts).
  if (sol > 0 && programs.some((p) => PUMP_PROGRAMS.has(p))) return { kind: "creator_claim", sol };
  return { kind: sol > 0 ? "deposit" : "withdrawal", sol };
}

/** Where the ledger reads the wallet's transactions. The real one is built from the agent's wallet; tests pass a fake. */
export interface FlowSource {
  /** Newest first, newer than `until` (all when null), older than `before`. */
  signatures(opts: { until: string | null; before?: string; limit: number }): Promise<{ signature: string; slot: number; err: unknown; blockTime?: number | null }[]>;
  tx(signature: string): Promise<TxLike | null>;
}

export function walletFlowSource(wallet: PublicKey): FlowSource {
  return {
    async signatures({ until, before, limit }) {
      noteCopyRpc();
      return withTimeout(copyConnection().getSignaturesForAddress(wallet, { until: until ?? undefined, before, limit }, "confirmed"), READ_MS, "wallet history");
    },
    tx: (signature) => withTimeout(fetchParsedOne(signature), READ_MS, "transaction"),
  };
}

interface Cursor {
  signature: string | null;
  slot: number;
}
const readCursor = (db: DB): Cursor | null => {
  try {
    const v = JSON.parse(getMeta(db, CURSOR_KEY) || "null") as Cursor | null;
    return v && typeof v.slot === "number" ? v : null;
  } catch {
    return null;
  }
};

interface Expect {
  sol: number;
  until: string;
}
/** Takes `sol` (a positive amount out) off the owner's announcement; true when it covers it. */
function useExpected(db: DB, sol: number, now: number): boolean {
  let e: Expect | null = null;
  try {
    e = JSON.parse(getMeta(db, EXPECT_KEY) || "null") as Expect | null;
  } catch {
    e = null;
  }
  if (!e || !(e.sol > 0) || !(Date.parse(e.until) > now) || sol > e.sol + EXPECT_SLACK_SOL) return false;
  setMeta(db, EXPECT_KEY, JSON.stringify({ sol: Math.max(0, e.sol - sol), until: e.until } satisfies Expect));
  return true;
}

/** Announces a withdrawal of up to `sol` in the next `hours`, so it doesn't pause the agent. */
export function expectWithdrawal(db: DB, sol: number, hours = 24, now = Date.now()): void {
  setMeta(db, EXPECT_KEY, JSON.stringify({ sol, until: new Date(now + hours * 3_600_000).toISOString() } satisfies Expect));
}

/**
 * Reads the wallet's new transactions up to `uptoSlot` and records its flows. The first pass only marks where to start
 * (what the wallet holds then is the starting point, not a deposit). Stops early, to go on next time, when a transaction
 * can't be read yet or MAX_READS were read.
 */
export async function scanFlows(db: DB, src: FlowSource, wallet: string, uptoSlot: number, opts: { outflowPauseSol: number; now?: number }): Promise<{ recorded: number; done: boolean }> {
  const now = opts.now ?? Date.now();
  const cursor = readCursor(db);
  if (!cursor) {
    const [newest] = await src.signatures({ until: null, limit: 1 });
    // A wallet without any history starts from nothing: its first deposit is recorded as one.
    setMeta(db, CURSOR_KEY, JSON.stringify((newest ? { signature: newest.signature, slot: newest.slot } : { signature: null, slot: 0 }) satisfies Cursor));
    return { recorded: 0, done: true };
  }
  const found: { signature: string; slot: number; err: unknown; blockTime?: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await src.signatures({ until: cursor.signature, before, limit: PAGE });
    found.push(...batch);
    if (batch.length < PAGE) break;
    before = batch[batch.length - 1].signature;
  }
  found.reverse(); // oldest first
  const own = db.prepare("SELECT 1 FROM copy_trades WHERE signature = ?");
  const seen = db.prepare("SELECT 1 FROM wallet_flows WHERE signature = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO wallet_flows (signature, slot, ts, kind, sol, units, expected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let recorded = 0;
  let reads = 0;
  let done = true;
  for (const s of found) {
    if (s.slot > uptoSlot) {
      done = false;
      break;
    }
    if (!own.get(s.signature) && !seen.get(s.signature)) {
      if (reads >= MAX_READS) {
        done = false;
        break;
      }
      reads++;
      const tx = await src.tx(s.signature).catch(() => null);
      if (!tx) {
        done = false;
        break;
      }
      const flow = classifyFlow(tx, wallet);
      if (flow) {
        const ts = new Date((tx.blockTime ?? s.blockTime ?? now / 1000) * 1000).toISOString();
        const expected = flow.kind === "withdrawal" && useExpected(db, -flow.sol, now);
        insert.run(s.signature, s.slot, ts, flow.kind, flow.sol, flow.kind === "swap" ? 0 : null, expected ? 1 : 0, nowIso());
        recorded++;
        noteFlow(db, flow, expected, opts.outflowPauseSol);
      }
    }
    setMeta(db, CURSOR_KEY, JSON.stringify({ signature: s.signature, slot: s.slot } satisfies Cursor));
  }
  return { recorded, done };
}

/** Tells about a new flow; an unexplained withdrawal above the line pauses new buys. */
function noteFlow(db: DB, flow: { kind: FlowKind; sol: number }, expected: boolean, outflowPauseSol: number): void {
  if (flow.kind === "deposit") return say("info", `Deposit recorded: ${amount(flow.sol)} came into the agent's wallet (it buys units, so it isn't counted as profit).`);
  if (flow.kind === "creator_claim") return say("info", `Creator rewards recorded: ${amount(flow.sol)} came into the agent's wallet from its coin (it buys units, so it isn't counted as profit).`);
  if (flow.kind === "swap") return say("warn", `A swap the agent didn't make moved ${amount(flow.sol)} in its wallet; the wallet sweep takes the tokens into account.`);
  if (expected) return say("info", `Withdrawal recorded: ${amount(-flow.sol)} left the agent's wallet, as announced.`);
  if (-flow.sol < outflowPauseSol) return say("info", `Withdrawal recorded: ${amount(-flow.sol)} left the agent's wallet.`);
  setMeta(db, "copy_paused", "1");
  setMeta(db, "copy_paused_by", "outflow");
  const text = `${amount(-flow.sol)} left the agent's wallet and no trade explains it. New buys are paused; sells and exits keep running. If it was you, "npm run resume" starts buying again (next time, "npm run funding -- expect <SOL>" first). If it wasn't, move what is left to safety.`;
  say("warn", text);
  void alert(db, "unknown_outflow", text);
}

/** Totals for `npm run funding` (console only). */
export function fundingTotals(db: DB): { deposits: number; withdrawals: number; swaps: number; unpriced: number; count: number } {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind IN ('deposit','creator_claim') THEN sol END), 0) deposits,
              COALESCE(SUM(CASE WHEN kind IN ('withdrawal','payout') THEN -sol END), 0) withdrawals,
              COUNT(CASE WHEN kind = 'swap' THEN 1 END) swaps, COUNT(CASE WHEN units IS NULL THEN 1 END) unpriced, COUNT(*) count
       FROM wallet_flows`,
    )
    .get() as { deposits: number; withdrawals: number; swaps: number; unpriced: number; count: number };
  return r;
}
