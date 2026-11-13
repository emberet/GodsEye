import type { Metadata } from "next";

export const metadata: Metadata = { title: "Live", description: "Memecoin trades on Solana as GodsEye reads them." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
