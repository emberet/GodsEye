/**
 * What the public website is allowed to show. The agent publishes (and the local database holds) its full
 * internal state; every public API answer passes through `publicView` first, which:
 *   • hides the hot wallet's address (anyone could watch, front-run or target it); its balance is shown (the owner asked);
 *   • hides the raw agent logs;
 *   • reduces each copy decision to its outcome (no internal reason text, sizing weight or latency);
 *   • hides the learned tuning thresholds (the "follow bar" and its history);
 *   • words the "insider" tier as an early-entry pattern: a heuristic, not an accusation.
 * Internal enums (tier "insider" etc.) are unchanged. The owner can see everything by setting
 * GODSEYE_FULL_FEED=1 on a dashboard that is not public.
 */

export const PUBLIC_TIER_LABEL = "Early-entry pattern";

export type PublicFeed =
  | "summary" | "logs" | "copies" | "smart" | "leaders" | "wallets" | "wallet" | "groups"
  | "performance" | "proof" | "rugchecks" | "stream";

/** True when this dashboard should show the full internal feed (owner-only deployments). */
export function fullFeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GODSEYE_FULL_FEED === "1";
}

/** Public wording for text that names the insider tier. */
export function publicText(s: string): string {
  return s.replace(/\bInsider pattern\b/g, PUBLIC_TIER_LABEL).replace(/\binsider pattern\b/g, PUBLIC_TIER_LABEL.toLowerCase());
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A copy decision reduced to its outcome. */
function publicTrade(t: Obj): Obj {
  const status = t.status;
  return {
    ...t,
    reason: status === "skipped" ? "Skipped by GodsEye's safety checks" : null,
    error: status === "failed" ? "The trade did not go through" : null,
    weight: null,
    latency_ms: null,
  };
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return publicText(v);
  if (Array.isArray(v)) return v.map(walk);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) out[k] = walk(x);
  return "leader_signature" in out && "status" in out ? publicTrade(out) : out;
}

/** The public version of one API answer. Unknown shapes pass through with only the wording changes. */
export function publicView<T>(feed: PublicFeed, body: T): T {
  if (isObj(body) && "error" in body) return body;
  if (feed === "logs") return [] as unknown as T;
  const out = walk(body);
  if (!isObj(out)) return out as T;
  if (feed === "summary" && isObj(out.wallet)) out.wallet = { pubkey: null, balanceSol: out.wallet.balanceSol ?? null, checkedAt: out.wallet.checkedAt ?? null };
  if (feed === "smart" && "followBar" in out) out.followBar = null;
  if (feed === "leaders") {
    if ("followBar" in out) out.followBar = null;
    if ("followBarHistory" in out) out.followBarHistory = [];
  }
  return out as T;
}
