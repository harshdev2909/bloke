import type { Metadata } from "next";

export const metadata: Metadata = { title: "The pool", description: "The counterparty to every trade, and the caps that keep it solvent." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
