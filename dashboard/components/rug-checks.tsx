"use client";
import { Window } from "@/components/window";
import { Badge } from "@/components/ui/badge";
import { TokenLink } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { DataState } from "@/components/data-state";
import { ago } from "@/lib/format";
import type { RugCheckEntry } from "@/lib/types";

/** Every token GodsEye considered copying, and whether it passed the rug check. */
export function RugChecks() {
  const { data, error, stale, updatedAt } = usePoll<RugCheckEntry[]>("/api/rugchecks", 60_000);
  const rows = data ?? [];
  const blocked = rows.filter((r) => r.verdict === "blocked").length;
  return (
    <Window title="Rug checks" right={<span className="text-muted-foreground">{rows.length - blocked} passed · {blocked} blocked</span>}>
      <p className="text-sm text-muted-foreground">
        Before copying a buy, GodsEye checks the coin. It blocks coins whose creator can freeze wallets, take tokens, pause transfers or mint more.
      </p>
      <DataState error={error} stale={stale} updatedAt={updatedAt} what="rug checks" />
      <div className="mt-2">
        {rows.length === 0 && <p className="py-3 text-sm text-muted-foreground">No coins checked yet.</p>}
        {rows.slice(0, 12).map((r) => (
          <div key={r.mint} className="line flex-wrap items-start sm:flex-nowrap">
            <Badge variant={r.verdict === "pass" ? "win" : "loss"}>{r.verdict === "pass" ? "Passed" : "Blocked"}</Badge>
            <TokenLink mint={r.mint} symbol={r.symbol} className="w-24 shrink-0 truncate font-semibold" />
            <div className="min-w-0 flex-1 text-sm">
              {r.blocks.map((b) => (
                <p key={b} className="text-loss">{b}</p>
              ))}
              {r.warnings.map((w) => (
                <p key={w} className="text-muted-foreground">{w}</p>
              ))}
              {r.blocks.length === 0 && r.warnings.length === 0 && <p className="text-muted-foreground">No risks found</p>}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {r.rugcheck_score !== null && <>risk {r.rugcheck_score}/100 · </>}
              {ago(r.checked_at)}
            </span>
          </div>
        ))}
      </div>
    </Window>
  );
}
