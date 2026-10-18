"use client";
import { Window } from "@/components/window";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/lib/use-poll";
import { ago } from "@/lib/format";
import type { RugCheckEntry } from "@/lib/types";

/** Every token GodsEye considered copying, and whether it passed the rug check. */
export function RugChecks() {
  const { data } = usePoll<RugCheckEntry[]>("/api/rugchecks", 60_000);
  const rows = data ?? [];
  const blocked = rows.filter((r) => r.verdict === "blocked").length;
  return (
    <Window title={`Rug checks · ${rows.length - blocked} passed · ${blocked} blocked`} className="mt-3">
      <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">
        Before copying a buy, GodsEye reads the token&apos;s settings on Solana and asks RugCheck. Blocked: creator can freeze wallets, take tokens, pause
        transfers or mint more, or a high RugCheck risk score. Warnings are shown but don&apos;t block.
      </p>
      <div className="divide-y">
        {rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No tokens checked yet.</p>}
        {rows.map((r) => (
          <div key={r.mint} className="flex flex-col gap-1 px-3 py-2 text-xs sm:flex-row sm:items-start sm:gap-3">
            <div className="flex shrink-0 items-center gap-2 sm:w-44">
              <Badge variant={r.verdict === "pass" ? "win" : "loss"}>{r.verdict === "pass" ? "passed" : "blocked"}</Badge>
              <span className="font-bold">{r.symbol}</span>
            </div>
            <div className="min-w-0 flex-1">
              {r.blocks.map((b) => (
                <p key={b} className="text-loss">✗ {b}</p>
              ))}
              {r.warnings.map((w) => (
                <p key={w} className="text-muted-foreground">! {w}</p>
              ))}
              {r.blocks.length === 0 && r.warnings.length === 0 && <p className="text-muted-foreground">no risks found</p>}
            </div>
            <div className="shrink-0 text-[11px] text-muted-foreground sm:text-right">
              {r.rugcheck_score !== null && <span>risk {r.rugcheck_score}/100 · </span>}
              {ago(r.checked_at)}
            </div>
          </div>
        ))}
      </div>
    </Window>
  );
}
