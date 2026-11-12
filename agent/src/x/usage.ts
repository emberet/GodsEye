/**
 * Once a day: X's own count of the posts read on this account, next to the agent's count for the same month.
 *
 * The dollar budget (client.ts) rests on the agent's count. A reader the agent doesn't know of (another program on the
 * same key) or a counting mistake would spend past the budget unseen, so the two figures are compared here. X's figure
 * may well be the lower one: it does not bill a post read twice in one day. Only X counting well above the agent is
 * worth a message to the owner.
 *
 * Kept in one private agent_meta row. Console only: nothing here goes to the log feed.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";
import { alert } from "../alerts";
import { HttpError } from "../http";
import { tweetsReadThisMonth, xConfigured, xGet, XRefused } from "./client";

/** What the last check found. */
export interface XUsageCheck {
  at: string;
  /** Posts X counted this calendar month (UTC); null when its figure could not be read. */
  theirs: number | null;
  /** Posts the agent counted this month, both budgets together. */
  ours: number;
  /** Why there is no figure from X: it refuses reads, or the request failed. */
  note?: "refused" | "failed";
}

interface UsageAnswer {
  data?: { daily_project_usage?: { usage?: { date?: string; usage?: number | string }[] } };
}

const KEY = "x_usage_check";
/** X counting this far above the agent is told: over a tenth more, and over 200 posts (a dollar). */
const TOLERANCE = 0.1;
const MIN_GAP = 200;

const fmt = (n: number) => n.toLocaleString("en-US");
const monthOf = (date: unknown): string | null => {
  const at = typeof date === "string" || typeof date === "number" ? new Date(date) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 7) : null;
};

/** The last check, or null before the first one. */
export function xUsageCheck(db: DB): XUsageCheck | null {
  try {
    const v = JSON.parse(getMeta(db, KEY) || "null") as XUsageCheck | null;
    return v && typeof v === "object" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The posts X counted in `month` (YYYY-MM, UTC). Throws when its answer can't be read that way. */
async function postsByX(month: string, now: number): Promise<number> {
  // Enough days to reach back to the 1st of the month (X gives 90 at most).
  const days = Math.min(90, new Date(now).getUTCDate() + 1);
  const r = await xGet<UsageAnswer>("/usage/tweets", { days: String(days), "usage.fields": "daily_project_usage" });
  const daily = r.data?.daily_project_usage?.usage;
  if (!Array.isArray(daily)) throw new Error("no daily usage in the answer");
  const dated = daily.filter((d) => monthOf(d?.date) !== null);
  if (daily.length && !dated.length) throw new Error("no readable day in the answer");
  return dated.filter((d) => monthOf(d.date) === month).reduce((n, d) => n + (Number(d.usage) || 0), 0);
}

/** Reads X's usage figure, keeps both counts and tells the owner when X's is well above the agent's. Never throws on X's account. */
export async function checkXUsage(db: DB, now = Date.now()): Promise<XUsageCheck | null> {
  if (!xConfigured()) return null;
  const month = new Date(now).toISOString().slice(0, 7);
  const check: XUsageCheck = { at: new Date(now).toISOString(), theirs: null, ours: 0 };
  try {
    check.theirs = await postsByX(month, now);
  } catch (e) {
    check.note = e instanceof XRefused ? "refused" : "failed";
    // The status only: what X answered stays out of the console too.
    console.log(`[x] usage check: X's own count could not be read (${e instanceof HttpError ? `status ${e.status}` : "no usable answer"}).`);
  }
  // Counted after the answer came, so reads made while waiting for it are in.
  check.ours = tweetsReadThisMonth(db, "research") + tweetsReadThisMonth(db, "social");
  setMeta(db, KEY, JSON.stringify(check));
  if (check.theirs !== null && check.theirs - check.ours > Math.max(MIN_GAP, check.ours * TOLERANCE)) {
    void alert(
      db,
      "x_usage",
      `X counts ${fmt(check.theirs)} posts read this month, the agent counted ${fmt(check.ours)}. Another program may be reading with the same X key, ` +
        "or the agent's count is short. The X budget rests on the agent's count, so the real bill may be above it: " +
        "check the usage page in the X developer console. Trading is not affected.",
      `month ${month}`,
    );
  }
  return check;
}
