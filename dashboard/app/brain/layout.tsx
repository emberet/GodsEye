import type { Metadata } from "next";

export const metadata: Metadata = { title: "Brain", description: "GodsEye's neural network, practising on paper next to today's rules." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
