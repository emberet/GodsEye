import Link from "next/link";
import { ChevronLeft } from "lucide-react";

/** Page title with an optional back button, a short line under it, and controls below. */
export function PageHeader({ title, kicker, back, children }: { title: string; kicker?: React.ReactNode; back?: string; children?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {back && (
          <Link href={back} className="dot bg-cream shadow-hard-sm" aria-label="Back">
            <ChevronLeft size={20} strokeWidth={2.6} aria-hidden />
          </Link>
        )}
        <div className="min-w-0">
          <h1 className="text-3xl font-black tracking-[-0.03em] sm:text-[38px]">{title}</h1>
          {kicker && <p className="mt-1 text-sm text-muted-foreground">{kicker}</p>}
        </div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
