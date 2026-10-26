/**
 * RECOVERY — copy trades left half-done by a crash or restart, and positions that no longer match the wallet.
 *
 * A buy is recorded as `pending` before it's sent. If GodsEye stops before recording the result, the row
 * stays pending (and keeps holding its share of the budget). This settles each one:
 *   • buy, wallet holds the token  → the swap landed: open the position from what the wallet holds
 *                                     (cost = the planned size; fees not recorded)
 *   • buy, wallet holds none       → nothing was bought: mark it failed
 *   • sell                          → mark it failed; the position stays open and the next exit retries
 *   • can't read the wallet         → leave it for the next pass
 * Paper trades never touched the chain: interrupted ones are simply failed.
 *
 * `reconcile` only reports: open positions whose recorded amount differs from what the wallet holds.
 */
import { type DB, nowIso } from "@godseye/shared";
import { say, short } from "../log";

interface PendingRow {
  id: number;
  leader: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  mode: "real" | "paper";
  size_sol: number | null;
}

/** Tokens of `mint` the agent wallet holds (UI units), or null if it couldn't be read. */
export type HeldTokens = (mint: string) => Promise<number | null>;

export async function recoverPending(db: DB, opts: { before: string; held: HeldTokens }): Promise<{ opened: number; failed: number; left: number }> {
  const rows = db
    .prepare("SELECT id, leader, mint, symbol, side, mode, size_sol FROM copy_trades WHERE status='pending' AND created_at < ? ORDER BY id")
    .all(opts.before) as PendingRow[];
  const out = { opened: 0, failed: 0, left: 0 };
  const fail = (r: PendingRow, why: string) => {
    db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run(why, r.id);
    out.failed++;
  };
  for (const r of rows) {
    if (r.side === "sell" || r.mode === "paper") {
      fail(r, r.side === "sell" ? "interrupted by a restart; the position stays open and will be sold again" : "interrupted by a restart (paper)");
      continue;
    }
    const alreadyOpen = db.prepare("SELECT id FROM positions WHERE status='open' AND mint=? AND mode='real'").get(r.mint) as { id: number } | undefined;
    if (alreadyOpen) {
      fail(r, "interrupted by a restart; a position in this token is already open");
      continue;
    }
    const held = await opts.held(r.mint).catch(() => null);
    if (held === null) {
      out.left++;
      continue;
    }
    if (held <= 0) {
      fail(r, "interrupted by a restart; nothing was bought");
      continue;
    }
    const cost = r.size_sol ?? 0;
    const price = cost > 0 ? cost / held : 0;
    const now = nowIso();
    const pos = db
      .prepare(
        `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, cost_usd, fee_sol, entry_price_sol, last_price_sol, last_price_ts, opened_at)
         VALUES (?, ?, ?, 'real', 'open', ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(r.mint, r.symbol, r.leader, held, held, cost, price, price, now, now);
    db.prepare("UPDATE copy_trades SET status='filled', token_amount=?, price_sol=?, position_id=?, filled_at=?, error=? WHERE id=?").run(
      held, price, Number(pos.lastInsertRowid), now, "recovered after a restart: amounts from the wallet, cost = planned size", r.id,
    );
    out.opened++;
    say("trade", `Recovered a buy of ${r.symbol ?? short(r.mint)} interrupted by a restart: the wallet holds ${held.toPrecision(4)}, position opened.`);
  }
  if (out.failed || out.opened) say("info", `Recovery: ${out.opened} interrupted buy(s) opened as positions, ${out.failed} interrupted trade(s) marked failed.`);
  return out;
}

/** Open real positions whose recorded token amount is off by more than `tolerance` from the wallet. Reports only. */
export async function reconcile(db: DB, held: HeldTokens, tolerance = 0.05): Promise<{ mint: string; recorded: number; held: number }[]> {
  const open = db.prepare("SELECT mint, symbol, token_amount FROM positions WHERE status='open' AND mode='real'").all() as { mint: string; symbol: string | null; token_amount: number }[];
  const off: { mint: string; recorded: number; held: number }[] = [];
  for (const p of open) {
    const h = await held(p.mint).catch(() => null);
    if (h === null) continue;
    const diff = Math.abs(h - p.token_amount) / Math.max(p.token_amount, 1e-12);
    if (diff > tolerance) {
      off.push({ mint: p.mint, recorded: p.token_amount, held: h });
      say("warn", `Position check: ${p.symbol ?? short(p.mint)} is recorded as ${p.token_amount.toPrecision(4)} tokens but the wallet holds ${h.toPrecision(4)}.`);
    }
  }
  return off;
}
