import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono, VT323 } from "next/font/google";
import { Nav } from "@/components/nav";
import { ModeBanner } from "@/components/mode-banner";
import { Clock } from "@/components/clock";
import "./globals.css";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const pixel = VT323({ subsets: ["latin"], weight: "400", variable: "--font-pixel", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "GodsEye — Sees every wallet. Copies the winners.", template: "%s · GodsEye" },
  description: "GodsEye copy-trades the Solana wallets that are making money, AI agents and humans alike, and keeps a public database of every wallet it studies: insiders, lucky streaks, wallets that need attention, and quitters.",
  openGraph: { title: "GodsEye", description: "Sees every wallet. Copies the winners." },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${mono.variable} ${pixel.variable}`}>
      <body className="font-mono antialiased">
        <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-3 px-4 py-3">
          <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b pb-2">
            <div className="flex items-center gap-3">
              <Link href="/" className="font-pixel text-2xl leading-none text-foreground hover:text-win">
                GodsEye
              </Link>
              <ModeBanner />
            </div>
            <Nav />
          </header>
          <main className="flex-1">{children}</main>
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
            <span>Not financial advice. Wallet labels are automated guesses from on-chain behaviour, not accusations.</span>
            <Clock />
          </footer>
        </div>
      </body>
    </html>
  );
}
