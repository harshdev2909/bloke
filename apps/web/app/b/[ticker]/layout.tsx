import type { Metadata } from "next";

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const t = decodeURIComponent(ticker).toUpperCase();
  return { title: `$${t}`, description: `Trade $${t}, $${t}.HYPE and $${t}.WORK on BLOKE.` };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
