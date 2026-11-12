/**
 * `npm run social` — the PRIVATE social layer (social/), for the owner on the server only: this month's X budget, what
 * the collector has gathered, and the wallets with the best social score with the accounts tied to them. Read-only.
 * Never published anywhere (site, API, snapshot, log feed).
 *
 *   --top 20      wallets listed
 */
import { openDbReadonly } from "@godseye/shared";
import { config } from "../config";
import { socialWarningMode } from "../social/labels";
import { socialTablesExist } from "../social/schema";
import { budgetCap, countsReadThisMonth, dayShare, spentThisMonth, spentToday, tweetsReadThisMonth, usd, usersReadThisMonth, type XBudget, xRefusal } from "../x/client";

const args = process.argv.slice(2);
const top = (() => {
  const i = args.indexOf("--top");
  const n = i >= 0 ? Number(args[i + 1]) : 20;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();
const db = openDbReadonly();
const fmt = (n: number) => n.toLocaleString("en-US");

/** One X budget in dollars, with what was read for the money. */
const budgetLine = (budget: XBudget): string =>
  `${usd(spentThisMonth(db, budget))} of ${usd(budgetCap(budget))} spent this month, ${usd(spentToday(db, budget))} of ${usd(dayShare(budget))} today ` +
  `(${fmt(tweetsReadThisMonth(db, budget))} posts, ${fmt(usersReadThisMonth(db, budget))} profiles, ${fmt(countsReadThisMonth(db, budget))} counts this month)`;
console.log(`X social budget: ${budgetLine("social")}${config.xBearerToken ? "" : "; X_BEARER_TOKEN not set, so nothing is collected"}.`);
console.log(`(The runner research counts apart: ${budgetLine("research")}.)`);
const refusal = xRefusal(db);
if (refusal) console.log(`X refuses reads (${refusal.why === "credits" ? "out of credits" : "over the usage cap"}) since ${refusal.since}; last tried ${refusal.last}.`);
if (!socialTablesExist(db)) {
  console.log("No social data yet: the collector creates its tables on its first run.");
  process.exit(0);
}

const count = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
const hasTable = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
console.log(
  `Accounts ${fmt(count("SELECT COUNT(*) n FROM social_accounts"))} · posts ${fmt(count("SELECT COUNT(*) n FROM social_posts"))} ` +
    `(${fmt(count("SELECT COUNT(*) n FROM social_posts WHERE mints != '[]'"))} with a coin address) · ` +
    `wallet links ${fmt(count("SELECT COUNT(*) n FROM social_wallet_accounts"))} over ${fmt(count("SELECT COUNT(DISTINCT wallet) n FROM social_wallet_accounts"))} wallets · ` +
    `wallets looked up ${fmt(count("SELECT COUNT(*) n FROM social_visits"))} · profile snapshots ${fmt(count("SELECT COUNT(*) n FROM social_account_snapshots"))}.`,
);
const byHow = db.prepare("SELECT how, COUNT(*) n FROM social_wallet_accounts GROUP BY how ORDER BY n DESC").all() as { how: string; n: number }[];
if (byHow.length) console.log(`Links by kind: ${byHow.map((r) => `${r.how} ${fmt(r.n)}`).join(", ")}.`);
// Labels (social/labels.ts): what X says about a wallet, as a hint. Never proof of who owns it or how good it is.
if (hasTable("social_wallet_labels")) {
  const byLabel = db.prepare("SELECT label, COUNT(*) n FROM social_wallet_labels GROUP BY label ORDER BY label").all() as { label: string; n: number }[];
  const warned = hasTable("social_warnings") ? count("SELECT COUNT(*) n FROM social_warnings") : 0;
  console.log(
    `Labels (a hint, never proof): ${byLabel.map((r) => `${r.label} ${fmt(r.n)}`).join(", ") || "none yet"}. ` +
      `Warning is ${socialWarningMode()}: ${fmt(warned)} copyable buys logged as "would have skipped"; none was blocked.`,
  );
}

const scores = db
  .prepare(
    `SELECT s.wallet, s.score, s.n_posts, s.model_version, s.updated_at FROM social_scores s WHERE s.score IS NOT NULL ORDER BY s.score DESC LIMIT ?`,
  )
  .all(top) as { wallet: string; score: number; n_posts: number | null; model_version: string | null; updated_at: string | null }[];
const handles = db.prepare(
  `SELECT COALESCE(a.username, ${hasTable("x_accounts") ? "x.username" : "NULL"}, l.author_id) handle, l.how, l.n, a.followers
     FROM social_wallet_accounts l LEFT JOIN social_accounts a ON a.id = l.author_id
     ${hasTable("x_accounts") ? "LEFT JOIN x_accounts x ON x.id = l.author_id" : ""}
    WHERE l.wallet = ? ORDER BY CASE l.how WHEN 'bio' THEN 0 WHEN 'tweet' THEN 1 WHEN 'timing' THEN 2 ELSE 3 END, l.n DESC LIMIT 5`,
);
console.log(`\nTOP WALLETS BY SOCIAL SCORE (predicted 14-day copy return)${scores[0]?.model_version ? `, model ${scores[0].model_version}` : ""}`);
if (!scores.length) console.log("  none yet: the social model hasn't scored any wallet.");
for (const s of scores) {
  const linked = handles.all(s.wallet) as { handle: string; how: string; n: number; followers: number | null }[];
  const tags = linked.map((h) => `@${h.handle} (${h.how}${h.n > 1 ? ` ×${h.n}` : ""}${h.followers !== null ? `, ${fmt(h.followers)} followers` : ""})`).join("  ");
  console.log(`  ${s.wallet}  score ${s.score.toFixed(3)}  ${s.n_posts ?? 0} posts  ${tags || "no linked account"}`);
}
db.close();
