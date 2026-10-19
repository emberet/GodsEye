"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Copy, House, WalletCards } from "lucide-react";
import { cn } from "@/lib/utils";

/** Four sections, each with its own tile colour; sub-pages are linked from inside each. */
export const NAV = [
  { href: "/", label: "Home", icon: House, tile: "bg-sun", match: ["/"] },
  { href: "/wallets", label: "Wallets", icon: WalletCards, tile: "bg-lime", match: ["/wallets", "/groups"] },
  { href: "/copies", label: "Copying", icon: Copy, tile: "bg-lilac", match: ["/copies", "/leaders", "/performance", "/proof"] },
  { href: "/stream", label: "Live", icon: Activity, tile: "bg-coral", match: ["/stream"] },
];

function useActive() {
  const path = usePathname();
  return (n: (typeof NAV)[number]) => (n.href === "/" ? path === "/" : n.match.some((m) => path.startsWith(m)));
}

/** Tile tabs, top right (tablet and up). */
export function Nav() {
  const isActive = useActive();
  return (
    <nav aria-label="Main" className="ml-auto hidden sm:block">
      <ul className="flex gap-2.5">
        {NAV.map((n) => {
          const on = isActive(n);
          return (
            <li key={n.href}>
              <Link href={n.href} aria-current={on ? "page" : undefined} className={cn("pill min-h-[48px] gap-2.5 pl-1.5 pr-4", on && "pill-on")}>
                <span className={cn("dot h-9 w-9 rounded-[10px] border-2", n.tile)} aria-hidden>
                  <n.icon size={17} strokeWidth={2.4} />
                </span>
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Phone tab bar: coloured icon tiles; the current one opens up with its name. */
export function BottomNav() {
  const isActive = useActive();
  return (
    <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-40 sm:hidden">
      <ul className="flex items-stretch gap-2 rounded-[20px] border-[3px] border-ink bg-card p-2 shadow-hard">
        {NAV.map((n) => {
          const on = isActive(n);
          return (
            <li key={n.href} className={cn(on ? "flex-[1.6]" : "flex-1")}>
              <Link
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex h-[52px] items-center justify-center gap-2 rounded-[14px] border-[2.5px] border-ink text-ink shadow-hard-sm",
                  n.tile,
                  on ? "px-3" : "",
                )}
                aria-label={n.label}
              >
                <n.icon size={20} strokeWidth={2.4} aria-hidden />
                {on && <span className="text-sm font-extrabold">{n.label}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Links between a section's pages. */
export function SubNav({ links }: { links: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Section" className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-2 pt-0.5">
      {links.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined} className={cn("pill shrink-0", path === l.href && "pill-on")}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export const COPYING_LINKS = [
  { href: "/copies", label: "Trades" },
  { href: "/leaders", label: "Who it copies" },
  { href: "/performance", label: "Results" },
  { href: "/proof", label: "Proof" },
];
export const WALLET_LINKS = [
  { href: "/wallets", label: "All wallets" },
  { href: "/groups", label: "New wallets by funder" },
];
