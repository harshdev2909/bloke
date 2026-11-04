"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Clock3 } from "lucide-react";
import { REJECT_MESSAGES, marketEngineAbi, type Lot, type Order } from "@bloke/sdk";
import { api, qk, useAddresses, useStreamChannels } from "@/lib/api";
import { ago, price, usdc, wadUsdc } from "@/lib/format";
import { useContractTx } from "@/lib/tx";
import { Sigil } from "@/components/sigil";
import { WalletButton } from "@/components/wallet-button";
import { cn } from "@/lib/cn";
import { Stipple } from "@/components/stipple";

export default function PortfolioPage() {
  const { address } = useAccount();
  const qc = useQueryClient();
  const w = useQuery({ queryKey: qk.wallet(address ?? "0x"), queryFn: () => api.wallet(address!), enabled: !!address, refetchInterval: 5_000 });
  useStreamChannels(address ? [`orders:${address.toLowerCase()}`] : [], () => {
    if (address) qc.invalidateQueries({ queryKey: qk.wallet(address) });
  });

  if (!address) {
    return (
      <div className="mx-auto mt-16 flex max-w-lg flex-col items-center gap-4 text-center">
        <Stipple name="philosopher" className="mb-4 w-72" sizes="288px" />
        <p className="display text-2xl font-bold">Your positions live here</p>
        <p className="text-ink-2">Connect a wallet to see open positions, pending orders and history.</p>
        <WalletButton />
      </div>
    );
  }
  const v = w.data?.data;
  const open = v?.lots.filter((l) => l.status === "open") ?? [];
  const closed = v?.lots.filter((l) => l.status !== "open") ?? [];
  const pending = v?.orders.filter((o) => o.status === "pending" || o.status === "deferred") ?? [];
  const equity = open.reduce((s, l) => s + BigInt(l.equity ?? "0"), 0n);
  const pnl = open.reduce((s, l) => s + BigInt(l.pricePnl ?? "0") + BigInt(l.fundingPnl ?? "0"), 0n);

  return (
    <div className="mt-10">
      <h1 className="display text-4xl font-extrabold md:text-5xl">Portfolio</h1>

      <section aria-label="Balances" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="tUSDC balance" value={v ? usdc(v.tusdc) : null} />
        <Tile label="Open equity" value={v ? wadUsdc(equity) : null} />
        <Tile label="Unrealised PnL" value={v ? wadUsdc(pnl, { sign: true }) : null} tone={pnl >= 0n ? "mint" : "coral"} />
        <Claimable claimable={v?.claimable} />
      </section>

      {pending.length > 0 && (
        <section aria-labelledby="pend-h" className="tile mt-6 p-5">
          <h2 id="pend-h" className="display mb-3 text-lg font-bold">
            Waiting to fill
          </h2>
          <ul className="space-y-2">
            {pending.map((o) => (
              <PendingRow key={o.orderId} o={o} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="open-h" className="tile mt-6 p-5">
        <h2 id="open-h" className="display mb-3 text-lg font-bold">
          Open positions
        </h2>
        {w.isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-16 rounded-[20px]" />
            ))}
          </div>
        ) : w.isError ? (
          <p className="text-neg">Couldn&apos;t load positions. They refresh every few seconds.</p>
        ) : open.length === 0 ? (
          <p className="rounded-[20px] bg-canvas px-4 py-6 text-center text-ink-2">
            Nothing open. <Link href="/" className="text-accent-ink underline-offset-4 hover:underline">Find someone to back</Link>.
          </p>
        ) : (
          <ul className="space-y-2">{open.map((l) => <LotRow key={l.lotId} l={l} />)}</ul>
        )}
      </section>

      <section aria-labelledby="hist-h" className="tile mt-6 p-5">
        <h2 id="hist-h" className="display mb-3 text-lg font-bold">
          History
        </h2>
        {closed.length === 0 ? (
          <p className="rounded-[20px] bg-canvas px-4 py-6 text-center text-ink-2">Closed positions show up here with their payout.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-ink-3">
                <tr>
                  <th className="pb-2 font-normal">Market</th>
                  <th className="pb-2 font-normal">Side</th>
                  <th className="pb-2 text-right font-normal">Size</th>
                  <th className="pb-2 text-right font-normal">Entry → exit</th>
                  <th className="pb-2 text-right font-normal">Payout</th>
                  <th className="pb-2 text-right font-normal">Closed</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((l) => (
                  <tr key={l.lotId} className="border-t border-[var(--color-line)]">
                    <td className="py-3 font-medium">{label(l)}</td>
                    <td className={l.side === 1 ? "text-accent-ink" : "text-berry"}>{l.side === 1 ? "Long" : "Short"}</td>
                    <td className="num text-right">{usdc(l.collateral)}</td>
                    <td className="num text-right text-ink-2">
                      {price(l.entryPrice)} → {l.close ? price(l.close.exitPrice) : "—"}
                    </td>
                    <td className="num text-right">{l.close ? usdc(l.close.payout) : l.status}</td>
                    <td className="text-right text-ink-3">{ago(l.close?.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const label = (l: Lot) => (l.leg === "blend" ? `$${l.ticker}` : `$${l.ticker}.${l.leg.toUpperCase()}`);

function Tile({ label, value, tone }: { label: string; value: string | null; tone?: "mint" | "coral" }) {
  return (
    <div className="tile px-5 py-4">
      <p className="text-xs text-ink-3">{label}</p>
      {value === null ? <div className="skeleton mt-2 h-7 w-24 rounded-full" /> : <p className={cn("num display mt-1 text-2xl font-semibold", tone === "mint" && "text-pos", tone === "coral" && "text-neg")}>{value}</p>}
    </div>
  );
}

function Claimable({ claimable }: { claimable?: string }) {
  const a = useAddresses();
  const tx = useContractTx();
  const has = claimable !== undefined && BigInt(claimable) > 0n;
  return (
    <div className="tile flex items-center justify-between gap-3 px-5 py-4">
      <div>
        <p className="text-xs text-ink-3">Claimable</p>
        {claimable === undefined ? <div className="skeleton mt-2 h-7 w-20 rounded-full" /> : <p className="num display mt-1 text-2xl font-semibold">{usdc(claimable)}</p>}
      </div>
      <button
        type="button"
        disabled={!has || tx.phase === "signing" || tx.phase === "submitted"}
        onClick={() => a && tx.send({ address: a.engine, abi: marketEngineAbi, functionName: "claim" }).catch(() => undefined)}
        className="rounded-full h-10 bg-sand-2 px-4 text-sm hover:bg-sand-2 disabled:opacity-40"
      >
        {tx.phase === "submitted" ? "Claiming…" : "Claim"}
      </button>
    </div>
  );
}

function LotRow({ l }: { l: Lot }) {
  const a = useAddresses();
  const tx = useContractTx();
  const [closing, setClosing] = useState(false);
  const pnl = BigInt(l.pricePnl ?? "0") + BigInt(l.fundingPnl ?? "0");
  const pct = Number((pnl * 10_000n) / (BigInt(l.collateral) * 10n ** 12n || 1n)) / 100;
  return (
    <motion.li layout className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[20px] bg-canvas px-4 py-3 text-sm">
      <Link href={`/b/${l.ticker}`} className="flex items-center gap-3">
        <Sigil ticker={l.ticker} size={36} />
        <span>
          <span className="block font-medium">{label(l)}</span>
          <span className={cn("text-xs", l.side === 1 ? "text-accent-ink" : "text-berry")}>{l.side === 1 ? "▲ Long" : "▼ Short"}</span>
        </span>
      </Link>
      <Field k="Size" v={usdc(l.collateral)} />
      <Field k="Entry" v={price(l.entryPrice)} />
      <Field k="Equity" v={wadUsdc(l.equity)} />
      <span className={cn("num", pnl >= 0n ? "text-pos" : "text-neg")}>
        {wadUsdc(pnl, { sign: true })} <span className="text-xs">({pct >= 0 ? "+" : "−"}{Math.abs(pct).toFixed(2)}%)</span>
      </span>
      <button
        type="button"
        disabled={closing}
        onClick={async () => {
          if (!a) return;
          setClosing(true);
          try {
            await tx.send({ address: a.engine, abi: marketEngineAbi, functionName: "requestClose", args: [BigInt(l.lotId), 300] });
          } catch {
            /* explained below */
          } finally {
            setClosing(false);
          }
        }}
        className="rounded-full ml-auto h-10 bg-sand-2 px-5 hover:bg-sand-2 disabled:opacity-50"
      >
        {closing ? "Closing…" : "Close"}
      </button>
      {tx.error && <p className="w-full text-xs text-neg">{tx.error}</p>}
    </motion.li>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <span className="block text-xs text-ink-3">{k}</span>
      <span className="num">{v}</span>
    </span>
  );
}

function PendingRow({ o }: { o: Order }) {
  return (
    <li className="flex items-center gap-3 rounded-[18px] bg-canvas px-4 py-3 text-sm">
      <Clock3 className="size-4 text-accent-ink motion-safe:animate-pulse" aria-hidden />
      <span className="font-medium">{o.kind === "close" ? "Close" : o.side === 1 ? "Long" : "Short"}</span>
      <span className="num text-ink-2">{o.kind !== "close" && usdc(o.collateral)}</span>
      <span className="ml-auto text-xs text-ink-3">
        {o.status === "deferred" ? REJECT_MESSAGES.Lagging : "Filling at next index update"} · {ago(o.requestedAt)}
      </span>
    </li>
  );
}
