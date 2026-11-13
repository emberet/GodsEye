"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Help that works on a phone: tap (or click, or Enter) to open a small note, tap anywhere else or Escape to close.
 * Replaces hover-only `title` tooltips for anything worth knowing. Wraps `children` when given, else shows an ⓘ.
 */
export function Tip({ text, children, className, label = "More about this" }: { text: React.ReactNode; children?: React.ReactNode; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // The note sits under its button, kept inside the screen (a button near the right edge would push it off).
  useLayoutEffect(() => {
    if (!open || !box.current || !note.current) return setAt(null);
    const b = box.current.getBoundingClientRect();
    const w = note.current.offsetWidth;
    setAt({ left: Math.max(8, Math.min(b.left, window.innerWidth - w - 8)), top: b.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", close);
    };
  }, [open]);
  return (
    <span ref={box} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={children ? undefined : label}
        className={cn("inline-flex items-center gap-1 text-left", !children && "min-h-[28px] min-w-[28px] justify-center rounded-full text-muted-foreground hover:text-foreground")}
      >
        {children ?? <Info size={15} strokeWidth={2.4} aria-hidden />}
      </button>
      {open && (
        <span
          id={id}
          ref={note}
          role="note"
          style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: "hidden" }}
          className="fixed z-50 w-max max-w-[min(18rem,80vw)] rounded-[12px] border-[2.5px] border-ink bg-card px-3 py-2 text-xs font-medium normal-case leading-snug tracking-normal text-foreground shadow-hard-sm">
          {text}
        </span>
      )}
    </span>
  );
}
