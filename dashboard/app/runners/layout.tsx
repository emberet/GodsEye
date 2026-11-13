import type { Metadata } from "next";

export const metadata: Metadata = { title: "Runners", description: "Coins that ran five times or more, and the wallets that caught them early." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
