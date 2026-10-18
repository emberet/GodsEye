"use client";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatusBadge({ live, heartbeat, className }: { live: boolean; heartbeat: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 border px-2 py-1 text-xs font-bold uppercase tracking-widest",
        live ? "border-win/50 bg-win/10 text-win" : "border-loss/50 bg-loss/10 text-loss",
        className,
      )}
      title={heartbeat ? `last heartbeat ${heartbeat}` : "no heartbeat yet"}
    >
      <span className="relative flex h-2.5 w-2.5">
        {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-win opacity-60" />}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", live ? "bg-win animate-pulsedot" : "bg-loss")} />
      </span>
      {live ? "GodsEye is live" : "GodsEye offline"}
      <span className="font-normal normal-case tracking-normal opacity-70">· {ago(heartbeat)}</span>
    </span>
  );
}
