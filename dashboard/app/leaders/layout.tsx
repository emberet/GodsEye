import type { Metadata } from "next";

export const metadata: Metadata = { title: "Who it copies", description: "The wallets GodsEye copies, and how much of its budget each gets." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
