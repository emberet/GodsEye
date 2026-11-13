import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallets", description: "Every wallet GodsEye studies, sorted by what its trades show." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
