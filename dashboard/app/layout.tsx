import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { BottomNav, Nav } from "@/components/nav";
import { ModeBanner } from "@/components/mode-banner";
import { Logo } from "@/components/logo";
import "./globals.css";

const sans = Archivo({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "GodsEye — Sees every wallet. Copies the winners.", template: "%s · GodsEye" },
  description: "GodsEye copy-trades the Solana wallets that are making money, AI agents and humans alike, and keeps a public database of every wallet it studies: early-entry patterns, lucky streaks, wallets that need attention, and quitters.",
  openGraph: { title: "GodsEye", description: "Sees every wallet. Copies the winners." },
};
// Live data: let shared caches keep pages for a minute at most (not the default year for static pages).
export const revalidate = 60;

export const viewport: Viewport = { themeColor: "#17171B" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="antialiased">
        <div className="mx-auto min-h-screen max-w-[1440px] px-4 pb-28 pt-4 sm:px-6 sm:pb-10 lg:px-8">
          <header className="flex flex-wrap items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5" aria-label="GodsEye home">
              <Logo size={52} />
              <span className="text-[26px] font-black tracking-[-0.03em] sm:text-[30px]">GodsEye</span>
            </Link>
            <ModeBanner />
            <Nav />
          </header>
          <main className="mt-6 flex flex-col gap-6">{children}</main>
          <footer className="mt-10 text-xs text-muted-foreground">Not financial advice. Wallet labels are pattern heuristics from public on-chain data, not accusations. Leader results are other wallets&apos; trades, not GodsEye&apos;s, and past results do not predict future ones.</footer>
        </div>
        <BottomNav />
      </body>
    </html>
  );
}
