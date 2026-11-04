"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { isAddress } from "viem";
import { api, qk } from "@/lib/api";
import { price, shortAddr, usdc, wadUsdc } from "@/lib/format";
import { Sigil } from "@/components/sigil";
import { cn } from "@/lib/cn";

/** Public trader book (read-only, PRD §14.2). */
export default function BookPage() {
  const { address } = useParams<{ address: `0x${string}` }>();
  const valid = isAddress(address);
  const q = useQuery({ queryKey: qk.wallet(address), queryFn: () => api.wallet(address), enabled: valid, refetchInterval: 10_000 });
  if (!valid) return <p className="tile mt-10 p-8 text-center text-ink-2">That isn&apos;t a wallet address.</p>;
  const lots = q.data?.data.lots.filter((l) => l.status === "open") ?? [];
  return (
    <div className="mt-10">
      <p className="text-sm text-ink-3">Public book</p>
      <h1 className="num display text-3xl font-extrabold" title={address}>
        {shortAddr(address)}
      </h1>
      {q.data?.data.rep && <p className="mt-1 text-ink-2">Rep {Math.round(q.data.data.rep.total).toLocaleString()}</p>}
      <section className="tile mt-6 p-5" aria-label="Open positions">
        {q.isLoading ? (
          <div className="skeleton h-16 rounded-[20px]" />
        ) : lots.length === 0 ? (
          <p className="rounded-[20px] bg-canvas px-4 py-6 text-center text-ink-2">No open positions.</p>
        ) : (
          <ul className="space-y-2">
            {lots.map((l) => {
              const pnl = BigInt(l.pricePnl ?? "0") + BigInt(l.fundingPnl ?? "0");
              return (
                <li key={l.lotId} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[20px] bg-canvas px-4 py-3 text-sm">
                  <Link href={`/b/${l.ticker}`} className="flex items-center gap-3 font-medium">
                    <Sigil ticker={l.ticker} size={32} />${l.ticker}
                    {l.leg !== "blend" && `.${l.leg.toUpperCase()}`}
                  </Link>
                  <span className={l.side === 1 ? "text-accent-ink" : "text-berry"}>{l.side === 1 ? "▲ Long" : "▼ Short"}</span>
                  <span className="num">{usdc(l.collateral)}</span>
                  <span className="num text-ink-2">@ {price(l.entryPrice)}</span>
                  <span className={cn("num ml-auto", pnl >= 0n ? "text-pos" : "text-neg")}>{wadUsdc(pnl, { sign: true })}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
