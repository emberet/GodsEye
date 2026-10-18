"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Window } from "@/components/window";
import { RugChecks } from "@/components/rug-checks";
import { Addr } from "@/components/wallet-badges";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { ago, dt, pct, pnlClass, signedSol, solscanTx } from "@/lib/format";
import type { CopiesData } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS: Record<string, "win" | "loss" | "amber" | "outline"> = { filled: "win", failed: "loss", pending: "amber", skipped: "outline" };

export default function CopiesPage() {
  const { data, updatedAt } = usePoll<CopiesData>("/api/copies", 10_000);
  const open = data?.open ?? [];
  const totalU = open.reduce((s, p) => s + (p.unrealized_sol ?? 0), 0);
  return (
    <>
      <PageHeader title="Copying" kicker={updatedAt ? `positions · updated ${updatedAt.toISOString().slice(11, 19)} UTC` : "positions"}>
        <SubNav links={COPYING_LINKS} />
      </PageHeader>

      <Window title={`Open positions · ${open.length}`} className="mb-3" right={<span className={cn("text-xs font-bold num", totalU >= 0 ? "text-win" : "text-loss")}>{signedSol(totalU)} SOL</span>}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Copied from</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Sold so far</TableHead>
              <TableHead className="text-right">Unrealized</TableHead>
              <TableHead>Mode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {open.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No open positions.</TableCell>
              </TableRow>
            )}
            {open.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-bold">{p.symbol ?? p.mint.slice(0, 6)}</TableCell>
                <TableCell><Addr address={p.leader} /></TableCell>
                <TableCell className="text-muted-foreground">{ago(p.opened_at)}</TableCell>
                <TableCell className="text-right">{p.cost_sol.toFixed(4)} SOL</TableCell>
                <TableCell className="text-right">{p.proceeds_sol > 0 ? `${p.proceeds_sol.toFixed(4)} SOL` : "—"}</TableCell>
                <TableCell className={cn("text-right font-bold", pnlClass(p.unrealized_pct))}>
                  {pct(p.unrealized_pct ?? null)} <span className="font-normal">({signedSol(p.unrealized_sol ?? null)})</span>
                </TableCell>
                <TableCell><Badge variant={p.mode === "real" ? "amber" : "outline"}>{p.mode}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Window>

      <Window title={`Copy decisions · latest ${data?.trades.length ?? 0}`} className="mb-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Leader</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">SOL</TableHead>
              <TableHead className="text-right">Delay</TableHead>
              <TableHead>Why / error</TableHead>
              <TableHead>Tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.trades ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No copy decisions yet.</TableCell>
              </TableRow>
            )}
            {(data?.trades ?? []).map((c) => (
              <TableRow key={c.id}>
                <TableCell className="text-muted-foreground">{dt(c.created_at)}</TableCell>
                <TableCell className={c.side === "buy" ? "text-win" : "text-loss"}>{c.side}</TableCell>
                <TableCell className="font-bold">{c.symbol ?? c.mint.slice(0, 6)}</TableCell>
                <TableCell><Addr address={c.leader} /></TableCell>
                <TableCell><Badge variant={STATUS[c.status]}>{c.status}</Badge></TableCell>
                <TableCell className="text-right">{c.size_sol?.toFixed(4) ?? "—"}</TableCell>
                <TableCell className="text-right text-muted-foreground">{c.latency_ms === null ? "—" : `${(c.latency_ms / 1000).toFixed(1)}s`}</TableCell>
                <TableCell className="max-w-[340px] truncate text-xs text-muted-foreground" title={c.error ?? c.reason ?? ""}>
                  {c.error ? <span className="text-loss">{c.error}</span> : c.reason}
                </TableCell>
                <TableCell>
                  {c.signature ? (
                    <a href={solscanTx(c.signature)} target="_blank" rel="noreferrer" className="text-muted-foreground underline">↗</a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Window>

      <Window title={`Closed · ${data?.closed.length ?? 0}`} className="mb-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Closed</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Copied from</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Proceeds</TableHead>
              <TableHead className="text-right">P&amp;L</TableHead>
              <TableHead>Exit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.closed ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Nothing closed yet.</TableCell>
              </TableRow>
            )}
            {(data?.closed ?? []).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-muted-foreground">{dt(p.closed_at)}</TableCell>
                <TableCell className="font-bold">{p.symbol ?? p.mint.slice(0, 6)}</TableCell>
                <TableCell><Addr address={p.leader} /></TableCell>
                <TableCell className="text-right">{p.cost_sol.toFixed(4)}</TableCell>
                <TableCell className="text-right">{p.proceeds_sol.toFixed(4)}</TableCell>
                <TableCell className={cn("text-right font-bold", pnlClass(p.pnl_sol))}>
                  {signedSol(p.pnl_sol)} <span className="font-normal">({pct(p.pnl_pct)})</span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{p.exit_reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Window>
      <RugChecks />
    </>
  );
}
