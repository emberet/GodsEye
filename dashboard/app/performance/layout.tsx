import type { Metadata } from "next";

export const metadata: Metadata = { title: "Results", description: "GodsEye's results over time, after fees." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
