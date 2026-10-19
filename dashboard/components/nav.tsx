"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Copy, House, WalletCards } from "lucide-react";
import { cn } from "@/lib/utils";

/** Four sections; each one's sub-pages are linked from inside it. */
export const NAV = [
  { href: "/", label: "Home", icon: House, match: ["/"] },
  { href: "/wallets", label: "Wallets", icon: WalletCards, match: ["/wallets", "/groups"] },
  { href: "/copies", label: "Copying", icon: Copy, match: ["/copies", "/leaders", "/performance", "/proof"] },
  { href: "/stream", label: "Live", icon: Activity, match: ["/stream"] },
];

function useActive() {
  const path = usePathname();
  return (n: (typeof NAV)[number]) => (n.href === "/" ? path === "/" : n.match.some((m) => path.startsWith(m)));
}

/** Pill tabs, top right (tablet and up). */
export function Nav() {
  const isActive = useActive();
  return (
    <nav aria-label="Main" className="ml-auto hidden sm:block">
      <ul className="flex gap-2">
        {NAV.map((n) => {
          const on = isActive(n);
          return (
            <li key={n.href}>
              <Link href={n.href} aria-current={on ? "page" : undefined} className={cn("pill min-h-[44px] bg-tab px-[18px]", on && "pill-on")}>
                <n.icon size={16} strokeWidth={1.8} aria-hidden />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Dark pill bar pinned to the bottom on phones. */
export function BottomNav() {
  const isActive = useActive();
  return (
    <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-40 sm:hidden">
      <ul className="grid grid-cols-4 gap-1 rounded-full bg-frame p-1.5 shadow-lg">
        {NAV.map((n) => {
          const on = isActive(n);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={cn("flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium", on ? "bg-white text-ink" : "text-[#F6F5F2]")}
              >
                <n.icon size={17} strokeWidth={1.8} aria-hidden />
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Pill links between a section's pages. */
export function SubNav({ links }: { links: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Section" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
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
