import type { Metadata } from "next";

export const metadata: Metadata = { title: "Rep", description: "Season 1 leaderboard. Rep rewards being early and right." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
