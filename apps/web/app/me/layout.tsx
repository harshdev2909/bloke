import type { Metadata } from "next";

export const metadata: Metadata = { title: "Get set up", description: "Connect a wallet, sign in, link GitHub or X and claim 10,000 tUSDC." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
