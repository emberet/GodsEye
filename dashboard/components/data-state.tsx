"use client";
import { AlertTriangle } from "lucide-react";
import { ago } from "@/lib/format";

/**
 * What a page shows when its data isn't plainly fresh:
 *   • couldn't load at all       → an error block (never a blank page or zeros)
 *   • loaded once, refresh fails → a small notice that the numbers are from earlier
 * Renders nothing while loading for the first time or when all is well.
 */
export function DataState({ error, stale, updatedAt, what = "this data" }: { error: string | null; stale: boolean; updatedAt: Date | null; what?: string }) {
  if (!error) return null;
  if (stale && updatedAt) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-[14px] border-[2.5px] border-ink bg-sun px-3 py-2 text-sm font-bold text-ink">
        <AlertTriangle size={16} strokeWidth={2.6} aria-hidden />
        Couldn&apos;t refresh {what}: showing it as of {ago(updatedAt.toISOString())}.
      </p>
    );
  }
  return (
    <p role="alert" className="card flex items-center gap-2 text-sm font-bold text-coral">
      <AlertTriangle size={16} strokeWidth={2.6} aria-hidden />
      Couldn&apos;t load {what}: {error}
    </p>
  );
}
