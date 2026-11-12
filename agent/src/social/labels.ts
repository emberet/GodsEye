/**
 * LABELS FROM THE SOCIAL LAYER — a hint, never proof.
 *
 * What X says about a wallet is boiled down to one private label (social_wallet_labels):
 *   claimed  an account's own bio carries the address. That is the account's word, and nobody has checked it.
 *   named    an account posted the address. The wallet is named BY that account; that says nothing about who owns it.
 * A wallet tied to an account only by timing (it keeps buying just before the account's calls) gets no label: nobody
 * posted its address.
 *
 * What a label is NOT: proof of who owns the wallet, or of how good it is. It is never used as evidence FOR a wallet: it
 * raises no copy weight, passes no gate, and enters neither wallet_evidence nor the proof ledger.
 *
 * Its one use is a possible WARNING, and only in shadow (SOCIAL_WARNING=shadow): each copyable buy by a labelled wallet
 * is written to social_warnings as "the warning would have skipped this", and the copy goes ahead exactly as before.
 * No setting lets the warning block a trade: that needs the owner's OK once the log has run, and is built then.
 *
 * PRIVATE like the rest of social/: nothing here goes to say(), agent_log, copy_trades or anything the site reads.
 */
import { type DB, nowIso } from "@godseye/shared";
import type { ParsedSwap } from "../chain/parse";
import { ensureSocialTables } from "./schema";

export type SocialLabel = "claimed" | "named";
export type SocialWarningMode = "off" | "shadow";

/** SOCIAL_WARNING: off (default) or shadow. Anything else, "on" included, is off: there is no live mode. */
export function socialWarningMode(env: NodeJS.ProcessEnv = process.env): SocialWarningMode {
  return env.SOCIAL_WARNING?.trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

export interface LabelCounts {
  claimed: number;
  named: number;
  /** Rows added or changed by this run. */
  changed: number;
}

/**
 * Refreshes the labels from the stored links (pure database work: no X call, so it runs with X off too).
 * A label is only ever added or raised from named to claimed, never removed, and `since` keeps the earliest time
 * (a link's own first_seen_at moves forward when the research re-files it, so the label can't lean on it later).
 */
export function labelWallets(db: DB): LabelCounts {
  ensureSocialTables(db);
  const changed = db
    .prepare(
      `INSERT INTO social_wallet_labels (wallet, label, accounts, since, updated_at)
       SELECT wallet, CASE WHEN SUM(how = 'bio') > 0 THEN 'claimed' ELSE 'named' END, COUNT(*), MIN(first_seen_at), $now
         FROM social_wallet_accounts WHERE how IN ('bio', 'tweet', 'mention') GROUP BY wallet
       ON CONFLICT(wallet) DO UPDATE SET
         label = CASE WHEN social_wallet_labels.label = 'claimed' THEN 'claimed' ELSE excluded.label END,
         accounts = excluded.accounts,
         since = MIN(social_wallet_labels.since, excluded.since),
         updated_at = excluded.updated_at
        WHERE (social_wallet_labels.label != 'claimed' AND social_wallet_labels.label != excluded.label)
           OR social_wallet_labels.accounts != excluded.accounts
           OR social_wallet_labels.since > excluded.since`,
    )
    .run({ now: nowIso() }).changes;
  const n = (label: SocialLabel) => (db.prepare("SELECT COUNT(*) AS n FROM social_wallet_labels WHERE label = ?").get(label) as { n: number }).n;
  return { claimed: n("claimed"), named: n("named"), changed };
}

/** A wallet's label, if it already had one at `atIso` (null otherwise). The kind and the count are the latest ones. */
export function socialLabelAt(db: DB, wallet: string, atIso: string = nowIso()): { label: SocialLabel; accounts: number; since: string } | null {
  const row = db.prepare("SELECT label, accounts, since FROM social_wallet_labels WHERE wallet = ? AND since <= ?").get(wallet, atIso);
  return (row as { label: SocialLabel; accounts: number; since: string } | undefined) ?? null;
}

/**
 * Called by the copy engine for every copyable leader buy. In shadow mode a buy by a labelled wallet gets one row in
 * social_warnings; the engine does nothing with the answer. Off: reads nothing, writes nothing, creates nothing.
 * Never throws: this is an observation, and a problem with it must not reach the copy.
 */
export function noteSocialWarning(
  db: DB,
  swap: Pick<ParsedSwap, "wallet" | "signature" | "mint" | "ts">,
  seenAt: number,
  mode: SocialWarningMode = socialWarningMode(),
): boolean {
  if (mode === "off") return false;
  try {
    ensureSocialTables(db);
    const seen = new Date(seenAt).toISOString();
    const l = socialLabelAt(db, swap.wallet, seen);
    if (!l) return false;
    return (
      db
        .prepare("INSERT OR IGNORE INTO social_warnings (leader_signature, mint, wallet, ts, seen_at, label, accounts, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(swap.signature, swap.mint, swap.wallet, swap.ts, seen, l.label, l.accounts, mode).changes > 0
    );
  } catch {
    return false;
  }
}
