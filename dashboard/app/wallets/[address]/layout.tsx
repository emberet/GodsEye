import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallet", description: "One wallet's trades, record and labels, as GodsEye reads them." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
