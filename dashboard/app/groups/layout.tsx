import type { Metadata } from "next";

export const metadata: Metadata = { title: "New wallets by funder", description: "Fresh wallets grouped by the wallet that first funded them." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
