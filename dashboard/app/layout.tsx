import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, Manrope } from "next/font/google";
import { BottomNav, Nav } from "@/components/nav";
import { ModeBanner } from "@/components/mode-banner";
import { Logo } from "@/components/logo";
import "./globals.css";

const sans = Manrope({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "GodsEye — Sees every wallet. Copies the winners.", template: "%s · GodsEye" },
  description: "GodsEye copy-trades the Solana wallets that are making money, AI agents and humans alike, and keeps a public database of every wallet it studies: insiders, lucky streaks, wallets that need attention, and quitters.",
  openGraph: { title: "GodsEye", description: "Sees every wallet. Copies the winners." },
};
export const viewport: Viewport = { themeColor: "#2A2A2F" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="antialiased">
        <div className="min-h-screen bg-frame p-2 sm:bg-transparent sm:p-5 lg:p-7">
          <div className="mx-auto max-w-[1240px] sm:rounded-[44px] sm:bg-frame sm:p-3 sm:shadow-[0_30px_60px_rgba(42,30,90,.25)]">
            <div className="relative min-h-[calc(100vh-1rem)] overflow-hidden rounded-[26px] bg-panel pb-24 sm:min-h-0 sm:rounded-[32px] sm:pb-8">
              <header className="flex flex-wrap items-center gap-3 px-4 pt-4 sm:px-5">
                <Link href="/" className="flex items-center gap-3 rounded-full pr-2" aria-label="GodsEye home">
                  <Logo />
                  <span className="text-2xl font-medium tracking-[-0.03em] sm:text-[30px]">GodsEye</span>
                </Link>
                <ModeBanner />
                <Nav />
              </header>
              <main className="flex flex-col gap-5 px-4 pt-5 sm:px-7">{children}</main>
              <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:px-7">
                <span>Not financial advice. Wallet labels are automated reads of on-chain behaviour, not accusations.</span>
              </footer>
              <BottomNav />
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
