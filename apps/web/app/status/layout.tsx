import type { Metadata } from "next";

export const metadata: Metadata = { title: "Status", description: "Live health of the oracle, indexer and contracts." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
