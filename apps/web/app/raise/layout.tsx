import type { Metadata } from "next";

export const metadata: Metadata = { title: "Raise", description: "Back a person before their token exists. All or nothing." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
