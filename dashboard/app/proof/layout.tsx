import type { Metadata } from "next";

export const metadata: Metadata = { title: "Proof", description: "GodsEye's tamper-evident record of every trade." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
