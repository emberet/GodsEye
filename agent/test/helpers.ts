import type { TxLike, TokenBalanceLike } from "../src/chain/parse";
import type { SwapLite } from "../src/analysis/pnl";

export const WALLET = "Wa11et1111111111111111111111111111111111111";
export const MINT = "Mint111111111111111111111111111111111111111";
export const POOL = "Poo1111111111111111111111111111111111111111";
export const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const pk = (s: string) => ({ pubkey: { toString: () => s } });
const prog = (s: string) => ({ programId: { toString: () => s } });

export function tokenBal(accountIndex: number, mint: string, owner: string, amount: number, decimals = 6): TokenBalanceLike {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } };
}

/** A transaction where WALLET (key 0) and a pool (key 1) swap SOL for MINT. */
export function swapTx(opts: {
  solDelta: number; // wallet's SOL change incl. fee, in SOL
  tokenBefore: number;
  tokenAfter: number;
  newTokenAccount?: boolean;
  programs?: string[];
  inner?: string[];
  fee?: number;
  err?: unknown;
  extraKeys?: { key: string; pre: number; post: number }[];
}): TxLike {
  const fee = opts.fee ?? 5000;
  const pre = [10e9, 100e9, 0];
  const post = [10e9 + Math.round(opts.solDelta * 1e9), 100e9 - Math.round(opts.solDelta * 1e9), 0];
  const keys = [pk(WALLET), pk(POOL), pk("TokAcct111111111111111111111111111111111111")];
  for (const k of opts.extraKeys ?? []) {
    keys.push(pk(k.key));
    pre.push(k.pre);
    post.push(k.post);
  }
  return {
    slot: 1,
    blockTime: 1_760_000_000,
    meta: {
      err: opts.err ?? null,
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: opts.newTokenAccount ? [] : [tokenBal(2, MINT, WALLET, opts.tokenBefore)],
      postTokenBalances: [tokenBal(2, MINT, WALLET, opts.tokenAfter)],
      innerInstructions: opts.inner ? [{ instructions: opts.inner.map(prog) }] : [],
    },
    transaction: { signatures: ["sig1"], message: { accountKeys: keys, instructions: (opts.programs ?? [JUP]).map(prog) } },
  };
}

let n = 0;
export function swap(p: Partial<SwapLite> & Pick<SwapLite, "ts" | "side" | "sol_amount" | "token_amount">): SwapLite {
  n++;
  return {
    signature: `s${n}`,
    mint: MINT,
    price_sol: p.sol_amount / p.token_amount,
    usd_amount: p.sol_amount * 100, // tests value SOL at $100 unless they say otherwise
    venue: "jupiter",
    jito_tip: 0,
    token_age_sec: null,
    ...p,
  };
}

export const iso = (msAgo: number, now = Date.now()) => new Date(now - msAgo).toISOString();
export const H = 3_600_000;
export const D = 24 * H;

/** Replaces fetch for one test: `handler` gets the URL and parsed JSON body and returns a Response, a JSON
 *  value (sent as 200), or undefined (the call fails as unexpected). Call `restore()` when done. */
export function stubFetch(handler: (url: string, body: unknown) => Response | object | undefined | Promise<Response | object | undefined>) {
  const calls: { url: string; body: unknown }[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    const out = await handler(url, body);
    if (out === undefined) throw new Error(`unexpected fetch in test: ${url}`);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = previous) };
}

/** Give every wallet in the database a copy replay that passes the copy gate (median +5% over 20 well-covered copies). */
export function passCopyGate(db: { prepare(sql: string): { run(...a: unknown[]): unknown } }): void {
  db.prepare("INSERT OR REPLACE INTO copy_replays (wallet, delay_sec, n, coverage, median_ret_pct, computed_at) SELECT address, 5, 20, 0.9, 5, ? FROM wallets").run(new Date().toISOString());
}
