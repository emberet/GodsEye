import { cn } from "@/lib/utils";

export function GlitchText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("glitch", className)} data-text={text}>
      {text}
    </span>
  );
}
