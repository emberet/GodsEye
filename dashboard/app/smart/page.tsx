"use client";
import { PageHeader } from "@/components/page-header";
import { Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { ago, dollars, pct, pnlClass, signedUsd } from "@/lib/format";
import type { SmartMoneyData } from "@/lib/types";
import { cn } from "@/lib/utils";

const tok = (symbol: string | null, mint: string) => symbol ?? `${mint.slice(0, 4)}…`;

export default function SmartMoneyPage() {
  const { data, error } = usePoll<SmartMoneyData>("/api/smart", 15_000);
  const flows = data?.flows ?? [];
  const score = (kind: "accumulate" | "exit", h: "1h" | "6h" | "24h") => data?.scorecard.find((x) => x.kind === kind && x.horizon === h);
  return (
    <>
      <PageHeader title="Smart money" kicker="where wallets that make money are putting it, and how that worked out" />
      {error && <p className="mb-3 text-sm text-loss">{error}</p>}

      <div className="mb-3 grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat className="border-0" label="Smart wallets" value={data?.activeWallets ?? "—"} sub={data?.droppedWallets ? `${data.droppedWallets} dropped for buying tops` : "being followed"} />
        <Stat className="border-0" label="Smart trades 24h" value={data?.trades24h.toLocaleString("en-US") ?? "—"} />
        {(["1h", "6h", "24h"] as const).map((h) => {
          const s = score("accumulate", h);
          return (
            <Stat
              key={h}
              className="border-0"
              label={`Buy signals · ${h}`}
              value={s?.hit_rate == null ? "—" : `${Math.round(s.hit_rate * 100)}% up`}
              sub={s ? `${s.measured}/${s.signals} measured · median ${pct(s.median_ret, 0)}` : ""}
              valueClass={s?.hit_rate == null ? "" : s.hit_rate >= 0.5 ? "text-win" : "text-loss"}
            />
          );
        })}
        {(() => {
          const s = score("exit", "6h");
          return <Stat className="border-0" label="Exit signals · 6h" value={s?.hit_rate == null ? "—" : `${Math.round(s.hit_rate * 100)}% down`} sub={s ? `${s.measured}/${s.signals} measured` : ""} />;
        })()}
      </div>

      <Window title="Where smart money is moving · last 24h" className="mb-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead className="text-right">Net 1h</TableHead>
              <TableHead className="text-right">Net 24h</TableHead>
              <TableHead className="text-right">Smart buyers</TableHead>
              <TableHead className="text-right">Smart sellers</TableHead>
              <TableHead className="text-right">Since first smart buy</TableHead>
              <TableHead>First smart buy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">{data ? "No smart-money trades yet. They appear as the live stream sees smart wallets trade." : "loading…"}</TableCell>
              </TableRow>
            )}
            {flows.map((f) => {
              const net1 = f.buy_usd_1h - f.sell_usd_1h;
              const net24 = f.buy_usd_24h - f.sell_usd_24h;
              return (
                <TableRow key={f.mint}>
                  <TableCell className="font-bold">
                    <a href={`https://dexscreener.com/solana/${f.mint}`} target="_blank" rel="noreferrer" className="hover:text-win">
                      {tok(f.symbol, f.mint)} ↗
                    </a>
                  </TableCell>
                  <TableCell className={cn("text-right", pnlClass(net1))}>{signedUsd(net1)}</TableCell>
                  <TableCell className={cn("text-right font-bold", pnlClass(net24))}>{signedUsd(net24)}</TableCell>
                  <TableCell className="text-right">{f.buyers_24h}</TableCell>
                  <TableCell className="text-right">{f.sellers_24h}</TableCell>
                  <TableCell className={cn("text-right", pnlClass(f.change_since_first_buy))}>{pct(f.change_since_first_buy, 0)}</TableCell>
                  <TableCell className="text-muted-foreground">{ago(f.first_smart_buy_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Window>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Window title="Signals · several smart wallets moving together">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead className="text-right">Wallets</TableHead>
                <TableHead className="text-right">USD</TableHead>
                <TableHead className="text-right">1h</TableHead>
                <TableHead className="text-right">6h</TableHead>
                <TableHead className="text-right">24h</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.signals ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No signals yet.</TableCell>
                </TableRow>
              )}
              {(data?.signals ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-muted-foreground">{ago(s.ts)}</TableCell>
                  <TableCell className="font-bold">{tok(s.symbol, s.mint)}</TableCell>
                  <TableCell className={s.kind === "accumulate" ? "text-win" : "text-loss"}>{s.kind === "accumulate" ? "buying" : "dumping"}</TableCell>
                  <TableCell className="text-right">{s.wallet_count}</TableCell>
                  <TableCell className="text-right">{dollars(s.usd)}</TableCell>
                  {[s.ret_1h, s.ret_6h, s.ret_24h].map((r, i) => (
                    <TableCell key={i} className={cn("text-right", pnlClass(r))}>{pct(r, 0)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Window>

        <Window title="Smart wallets · what their buys did next">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Wallet</TableHead>
                <TableHead>Why</TableHead>
                <TableHead className="text-right">Buys measured</TableHead>
                <TableHead className="text-right">Up after 6h</TableHead>
                <TableHead className="text-right">Median 6h</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.wallets ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">No smart wallets yet.</TableCell>
                </TableRow>
              )}
              {(data?.wallets ?? []).map((w) => (
                <TableRow key={w.address} className={w.active ? "" : "opacity-50"}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Addr address={w.address} internal={w.tier !== null} />
                      {w.tier && <TierBadge tier={w.tier} />}
                      {w.kind && <KindBadge kind={w.kind} score={null} />}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={w.reason ?? ""}>{w.reason}</TableCell>
                  <TableCell className="text-right">{w.lead_n}</TableCell>
                  <TableCell className="text-right">{w.lead_hit_rate == null ? "—" : `${Math.round(w.lead_hit_rate * 100)}%`}</TableCell>
                  <TableCell className={cn("text-right", pnlClass(w.lead_median_6h))}>{pct(w.lead_median_6h, 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Window>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Smart money = wallets with a track record (10+ closed trades in 30 days, profitable, win rate ≥ the learned follow bar
        {data?.followBar ? `, now ${Math.round(data.followBar.value * 100)}%` : ""}) plus wallets winning big on the live stream right now. A
        signal = 3+ smart wallets buying (or dumping) the same token within an hour. Returns use prices seen on the live stream 1, 6 and 24 hours later. Wallets whose
        buys keep going down afterwards stop counting as smart money. Not financial advice.
      </p>
    </>
  );
}
