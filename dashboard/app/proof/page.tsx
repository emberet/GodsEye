"use client";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Window } from "@/components/window";
import { Badge } from "@/components/ui/badge";
import { usePoll } from "@/lib/use-poll";
import { DataState } from "@/components/data-state";
import { dt } from "@/lib/format";
import type { ProofData, ProofRow } from "@/lib/types";

/** Recompute sha256(prev_hash + "|" + payload) in YOUR browser. */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function ProofPage() {
  const [page, setPage] = useState(0);
  const { data, error, stale, updatedAt } = usePoll<ProofData>(`/api/proof?limit=25&offset=${page * 25}`, 30_000);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const verify = async (e: ProofRow) => {
    const h = await sha256Hex(`${e.prev_hash}|${e.payload}`);
    setChecked((c) => ({ ...c, [e.id]: h === e.hash }));
  };

  return (
    <>
      <PageHeader title="Proof" back="/copies" kicker="A tamper-proof record of every decision GodsEye makes.">
        <SubNav links={COPYING_LINKS} />
        {data && (
          <Badge variant={data.chain.ok ? "win" : "loss"}>
            {data.chain.ok ? `Record intact · ${data.chain.checked} entries` : `Record broken at #${data.chain.brokenAtId}`}
          </Badge>
        )}
      </PageHeader>
      <DataState error={error} stale={stale} updatedAt={updatedAt} what="the proof ledger" />
      <Window title="Ledger">
        <p className="text-sm text-muted-foreground">
          Each buy, sell and safety exit is written down with a fingerprint before it runs, and each fingerprint includes the one before it, so changing any old entry breaks
          every one after. Tap Check to recompute one in your browser: <code className="font-mono text-xs text-ink">sha256(prev_hash + &quot;|&quot; + payload)</code>
        </p>
        <div className="mt-2">
          {(data?.entries ?? []).length === 0 && <p className="py-3 text-sm text-muted-foreground">No entries yet.</p>}
          {(data?.entries ?? []).map((e) => (
            <details key={e.id} className="group border-t border-chip py-2 first:border-t-0">
              <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground num">#{e.id}</span>
                <Badge variant="outline">{e.kind.replace("_", " ")}</Badge>
                <span className="text-muted-foreground">{dt(e.committed_at)}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-accent">{e.hash}</code>
                <button
                  type="button"
                  aria-label={`Check entry #${e.id}`}
                  className="btn min-h-[36px] px-4"
                  onClick={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    void verify(e);
                  }}
                >
                  Check
                </button>
                {checked[e.id] !== undefined && <Badge variant={checked[e.id] ? "win" : "loss"}>{checked[e.id] ? "Matches" : "Doesn't match"}</Badge>}
              </summary>
              <div className="mt-2 space-y-1 text-xs">
                <p className="text-muted-foreground">
                  prev_hash: <code className="break-all">{e.prev_hash}</code>
                </p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-[12px] border-2 border-ink bg-panel p-3 font-mono text-foreground">{e.payload}</pre>
              </div>
            </details>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-center gap-3 text-sm">
          <button type="button" className="btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Newer
          </button>
          <span className="text-muted-foreground">
            page {page + 1} / {Math.max(1, Math.ceil((data?.total ?? 0) / 25))}
          </span>
          <button type="button" className="btn" disabled={(page + 1) * 25 >= (data?.total ?? 0)} onClick={() => setPage((p) => p + 1)}>
            Older
          </button>
        </div>
      </Window>
    </>
  );
}
