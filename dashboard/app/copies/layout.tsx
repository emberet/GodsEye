import type { Metadata } from "next";

export const metadata: Metadata = { title: "Copying", description: "Every trade GodsEye copied, open and closed, after fees." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
