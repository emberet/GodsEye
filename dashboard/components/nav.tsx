"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Four sections; each one's sub-pages are linked from inside it. */
export const NAV = [
  { href: "/", label: "Home", match: ["/"] },
  { href: "/stream", label: "Live", match: ["/stream"] },
  { href: "/wallets", label: "Wallets", match: ["/wallets", "/groups"] },
  { href: "/copies", label: "Copying", match: ["/copies", "/leaders", "/performance", "/proof"] },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex gap-4 text-xs uppercase tracking-widest">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" : n.match.some((m) => path.startsWith(m));
          return (
            <li key={n.href}>
              <Link href={n.href} aria-current={active ? "page" : undefined} className={cn("py-1 transition-colors", active ? "border-b-2 border-win text-win" : "text-muted-foreground hover:text-foreground")}>
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Small links between a section's pages. */
export function SubNav({ links }: { links: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={cn(path === l.href ? "text-win" : "text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground")}>
          {l.label}
        </Link>
      ))}
    </div>
  );
}

export const COPYING_LINKS = [
  { href: "/copies", label: "Positions" },
  { href: "/leaders", label: "Who it copies" },
  { href: "/performance", label: "Performance" },
  { href: "/proof", label: "Proof ledger" },
];
export const WALLET_LINKS = [
  { href: "/wallets", label: "All wallets" },
  { href: "/groups", label: "Fresh wallets by funder" },
];
