import type { Metadata } from "next";

export const metadata: Metadata = { title: "Portfolio", description: "Your open positions, pending orders and history." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
