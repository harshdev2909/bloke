"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { ArrowLeft, BadgeCheck, ShieldAlert } from "lucide-react";
import type { Envelope, BlokeDetail, Leg, WalletView } from "@bloke/sdk";
import { SOURCE_LABEL, marketEngineAbi } from "@bloke/sdk";
import { api, qk, useAddresses, useArchetypes, useStreamChannels } from "@/lib/api";
import { ArchetypeCard } from "@/components/archetype-card";
import { GraduationPanel } from "@/components/graduation";
import { RaisePanel } from "@/components/raise";
import { PowPanel } from "@/components/pow";
import { idx, pctWad, price, wadUsdc, usdc, shortAddr } from "@/lib/format";
import { useContractTx } from "@/lib/tx";
import { Sigil } from "@/components/sigil";
import { TwinArc } from "@/components/gauges";
import { IndexChart } from "@/components/chart";
import { TradeTicket } from "@/components/trade-ticket";
import { Badge, Change } from "@/components/bloke-card";
import { cn } from "@/lib/cn";

const RANGES = ["1h", "24h", "7d"] as const;

export default function BlokePage() {
  const { ticker: raw } = useParams<{ ticker: string }>();
  const ticker = decodeURIComponent(raw).toUpperCase();
  const qc = useQueryClient();
  const [leg, setLeg] = useState<Leg>("blend");
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const q = useQuery({ queryKey: qk.bloke(ticker), queryFn: () => api.bloke(ticker), refetchInterval: 10_000 });
  const series = useQuery({ queryKey: qk.index(ticker, leg, range), queryFn: () => api.index(ticker, { leg, range }), refetchInterval: 20_000 });

  // Live index ticks update the header without refetching.
  useStreamChannels([`index:${ticker}`], (m) => {
    if (m.event.type !== "index") return;
    const e = m.event;
    qc.setQueryData<Envelope<BlokeDetail>>(qk.bloke(ticker), (old) =>
      old?.data.index ? { ...old, data: { ...old.data, index: { ...old.data.index, b: e.b, h: e.h, w: e.w, lagFlags: e.lagFlags, tsMs: e.tsMs, fresh: true } } } : old,
    );
  });

  if (q.isError) {
    return (
      <div className="tile mt-10 p-10 text-center">
        <p className="display text-2xl font-bold">No Bloke called ${ticker}</p>
        <p className="mt-2 text-ink-2">Check the ticker, or browse everyone on the floor.</p>
        <Link href="/" className="rounded-full mt-6 inline-flex h-11 items-center gap-2 bg-sand-2 px-5 hover:bg-sand-2">
          <ArrowLeft className="size-4" aria-hidden /> Back to the floor
        </Link>
      </div>
    );
  }
  const b = q.data?.data;
  if (!b) return <BlokeSkeleton />;
  const m = b.markets.find((x) => x.leg === leg)!;

  return (
    <div className="mt-8">
      <Link href="/" className="rounded-full mb-6 inline-flex h-10 items-center gap-2 px-3 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Floor
      </Link>

      <StatusBanner b={b} />

      {/* Header: sigil, identity, live index and the HYPE/WORK balance */}
      <header className="tile relative grid items-center gap-6 overflow-hidden p-6 md:grid-cols-[auto_1fr_auto] md:p-8">
        <motion.div initial={{ rotate: -20, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} transition={{ duration: 0.4, ease: [0, 0, 0.2, 1] }}>
          <Sigil ticker={b.ticker} h={b.index?.h} w={b.index?.w} size={112} />
        </motion.div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="display text-4xl font-extrabold md:text-5xl">${b.ticker}</h1>
            <Badge kind={b.badge} />
            {b.claimed ? (
              <span className="rounded-full inline-flex h-6 items-center gap-1 bg-pos/10 px-2.5 text-[11px] text-pos">
                <BadgeCheck className="size-3.5" aria-hidden /> Claimed
              </span>
            ) : (
              <span className="rounded-full inline-flex h-6 items-center bg-sand-2 px-2.5 text-[11px] text-ink-2">Unclaimed</span>
            )}
          </div>
          <p className="mt-1 text-lg text-ink-2">{b.name}</p>
          {!b.claimed && <p className="mt-2 text-xs text-ink-3">Not affiliated with or endorsed by this person.</p>}
          <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-xs text-ink-3">Human Capital Score</p>
              <p className="num display text-5xl font-semibold leading-none">{idx(b.index?.b)}</p>
            </div>
            <Change v={b.change1h} />
            <div className="text-sm">
              <p className="text-xs text-ink-3">Mark · {leg === "blend" ? `$${b.ticker}` : `.${leg.toUpperCase()}`}</p>
              <p className="num">{price(m.mark)}</p>
            </div>
            <div className="text-sm">
              <p className="text-xs text-ink-3">Premium</p>
              <p className="num">{pctWad(m.premium)}</p>
            </div>
            <div className="text-sm">
              <p className="text-xs text-ink-3">Net open interest</p>
              <p className="num">{wadUsdc(m.netNotional, { compact: true })}</p>
            </div>
          </div>
        </div>
        <TwinArc h={b.index?.h ?? 0} w={b.index?.w ?? 0} size={148} />
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <section aria-labelledby="chart-h" className="tile p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="chart-h" className="display text-lg font-bold">
                {leg === "blend" ? "Blended index" : leg === "hype" ? "HYPE · attention" : "WORK · shipped output"}
              </h2>
              <div role="radiogroup" aria-label="Range" className="rounded-full flex gap-1 bg-canvas p-1">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={range === r}
                    onClick={() => setRange(r)}
                    className={cn("rounded-full num h-9 px-3.5 text-xs", range === r ? "bg-ink text-canvas" : "text-ink-2 hover:text-ink")}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            {series.isLoading ? <div className="skeleton h-[260px] rounded-[24px]" /> : <IndexChart points={series.data?.data ?? []} leg={leg} />}
          </section>

          <Signals ticker={b.ticker} />
          <PowPanel b={b} />
          <YourLots ticker={b.ticker} blokeId={b.id} />
          <GraduationPanel b={b} />
        </div>
        <div className="lg:sticky lg:top-28 lg:self-start">
          <TradeTicket bloke={b} leg={leg} onLeg={setLeg} />
          <Markets b={b} />
          <div className="mt-4">
            <RaisePanel b={b} />
          </div>
          <BlokeArchetype id={b.archetype} />
        </div>
      </div>
    </div>
  );
}

/** What moves this index right now: each source's z-score against the person's own baseline. */
function Signals({ ticker }: { ticker: string }) {
  const q = useQuery({ queryKey: ["signals", ticker], queryFn: () => api.signals(ticker), refetchInterval: 30_000 });
  const rows = q.data?.data ?? [];
  if (q.isLoading) return <div className="skeleton h-40 rounded-[32px]" />;
  if (q.data?.meta.mode !== "signals" || rows.length === 0) return null;
  const hype = new Set(["x", "reddit", "search", "hn"]);
  return (
    <section aria-labelledby="sig-h" className="tile p-5">
      <h2 id="sig-h" className="text-sm font-medium">
        Signals
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {rows.map((r) => {
          const pct = Math.min(50, (Math.abs(r.z) / 4) * 50);
          return (
            <li key={r.source} className="rounded-[20px] bg-canvas px-4 py-3">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  {SOURCE_LABEL[r.source]} <span className="text-ink-3">· {hype.has(r.source) ? "HYPE" : "WORK"}</span>
                </span>
                <span className={cn("num", r.degraded ? "text-ink-3" : r.z >= 0 ? "text-pos" : "text-neg")}>
                  {r.degraded ? "paused" : `${r.z >= 0 ? "+" : ""}${r.z.toFixed(2)}σ`}
                </span>
              </div>
              <div className="relative mt-2 h-1.5 rounded-full bg-sand" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
                <span
                  className={cn("absolute inset-y-0 rounded-full", r.z >= 0 ? "left-1/2 bg-pos" : "right-1/2 bg-neg")}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="num mt-2 text-xs text-ink-3">weight {Math.round(r.weight * 100)}%</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BlokeArchetype({ id }: { id: BlokeDetail["archetype"] }) {
  const q = useArchetypes();
  const a = id && q.data?.data.find((x) => x.id === id);
  if (!a) return null;
  return (
    <div className="mt-4">
      <ArchetypeCard a={{ ...a, blokes: 0 }} />
    </div>
  );
}

function StatusBanner({ b }: { b: BlokeDetail }) {
  const stale = b.index && !b.index.fresh;
  const msg =
    b.status === "shadow"
      ? { tone: "info", text: "Shadow period: the index runs live so you can watch it, and trading opens when it ends." }
      : b.status === "delist_pending"
        ? { tone: "warn", text: "Removal requested. Markets accept only orders that reduce exposure while it's reviewed." }
        : b.status === "delisted"
          ? { tone: "warn", text: `Delisted. Open positions settle at ${idx(b.settlePrice?.b)} with no fee; claim them from your portfolio.` }
          : stale
            ? { tone: "warn", text: "The index hasn't updated in over a minute. Trading pauses until it does; your positions are safe." }
            : null;
  if (!msg) return null;
  return (
    <p
      role="status"
      className={cn(
        "mb-4 flex items-start gap-3 rounded-[20px] px-5 py-4 text-sm",
        msg.tone === "warn" ? "bg-berry-wash text-berry" : "bg-accent-wash text-accent-ink",
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {msg.text}
    </p>
  );
}

function Markets({ b }: { b: BlokeDetail }) {
  return (
    <section aria-labelledby="mk-h" className="tile mt-4 p-5">
      <h2 id="mk-h" className="mb-3 text-sm font-medium text-ink-2">
        Markets
      </h2>
      <ul className="space-y-2 text-sm">
        {b.markets.map((m) => (
          <li key={m.marketId} className="flex items-center justify-between rounded-[16px] bg-canvas px-4 py-2.5">
            <span className="font-medium">{m.leg === "blend" ? `$${b.ticker}` : `.${m.leg.toUpperCase()}`}</span>
            <span className="num text-ink-2">{price(m.mark)}</span>
            <span className="text-xs text-ink-3">
              {m.openLots} open · <span className="num">{m.status}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function YourLots({ ticker, blokeId }: { ticker: string; blokeId: number }) {
  const { address } = useAccount();
  const a = useAddresses();
  const tx = useContractTx();
  const qc = useQueryClient();
  const [closing, setClosing] = useState<string | null>(null);
  const w = useQuery({ queryKey: qk.wallet(address ?? "0x"), queryFn: () => api.wallet(address!), enabled: !!address, refetchInterval: 5_000 });
  if (!address) return null;
  const lots = (w.data as Envelope<WalletView> | undefined)?.data.lots.filter((l) => l.blokeId === blokeId && l.status === "open") ?? [];
  return (
    <section aria-labelledby="lots-h" className="tile p-5">
      <h2 id="lots-h" className="display mb-3 text-lg font-bold">
        Your positions on ${ticker}
      </h2>
      {w.isLoading ? (
        <div className="skeleton h-16 rounded-[20px]" />
      ) : lots.length === 0 ? (
        <p className="rounded-[20px] bg-canvas px-4 py-5 text-sm text-ink-2">No open positions here yet. Use the ticket to open one.</p>
      ) : (
        <ul className="space-y-2">
          {lots.map((l) => {
            const pnl = BigInt(l.pricePnl ?? "0") + BigInt(l.fundingPnl ?? "0");
            return (
              <li key={l.lotId} className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[20px] bg-canvas px-4 py-3 text-sm">
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", l.side === 1 ? "bg-accent-wash text-accent-ink" : "bg-berry-wash text-berry")}>
                  {l.side === 1 ? "Long" : "Short"} {l.leg === "blend" ? `$${ticker}` : `.${l.leg.toUpperCase()}`}
                </span>
                <span>
                  <span className="text-xs text-ink-3">Size </span>
                  <span className="num">{usdc(l.collateral)}</span>
                </span>
                <span>
                  <span className="text-xs text-ink-3">Entry </span>
                  <span className="num">{price(l.entryPrice)}</span>
                </span>
                <span className={cn("num", pnl >= 0n ? "text-pos" : "text-neg")}>{wadUsdc(pnl, { sign: true })}</span>
                <button
                  type="button"
                  disabled={closing === l.lotId}
                  onClick={async () => {
                    if (!a) return;
                    setClosing(l.lotId);
                    try {
                      await tx.send({ address: a.engine, abi: marketEngineAbi, functionName: "requestClose", args: [BigInt(l.lotId), 300] });
                      setTimeout(() => qc.invalidateQueries({ queryKey: qk.wallet(address) }), 1500);
                    } finally {
                      setClosing(null);
                    }
                  }}
                  className="rounded-full ml-auto h-9 bg-sand-2 px-4 text-sm hover:bg-sand-2 disabled:opacity-50"
                >
                  {closing === l.lotId ? "Closing…" : "Close"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {tx.error && <p className="mt-3 text-sm text-neg">{tx.error}</p>}
    </section>
  );
}

function BlokeSkeleton() {
  return (
    <div className="mt-20 space-y-6" aria-busy="true" aria-label="Loading">
      <div className="tile flex items-center gap-6 p-8">
        <div className="skeleton size-28 rounded-full" />
        <div className="flex-1 space-y-3">
          <div className="skeleton h-10 w-48 rounded-full" />
          <div className="skeleton h-5 w-32 rounded-full" />
          <div className="skeleton h-12 w-40 rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
        <div className="skeleton h-80 rounded-[28px]" />
        <div className="skeleton h-[520px] rounded-[28px]" />
      </div>
    </div>
  );
}
