"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import type { ArchetypeId } from "@bloke/sdk";
import { useArchetypes, useBlokes, useFeed } from "@/lib/api";
import { idx, price, shortAddr, wadUsdc } from "@/lib/format";
import { BlokeRow, BlokeRowSkeleton } from "@/components/bloke-card";
import { Art } from "@/components/art";
import { ArchetypeCard, ArchetypeCardSkeleton } from "@/components/archetype-card";
import { HallOfFounders } from "@/components/hall";
import { cn } from "@/lib/cn";

const FILTERS = [
  { id: "all", label: "Everyone" },
  { id: "underrated", label: "Underrated" },
  { id: "overhyped", label: "Overhyped" },
  { id: "live", label: "Trading" },
  { id: "shadow", label: "Shadow" },
] as const;

const enter = (delay = 0) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, ease: [0, 0, 0.2, 1] as const, delay },
});

export default function FloorPage() {
  const q = useBlokes();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [arch, setArch] = useState<ArchetypeId | null>(null);
  const archetypes = useArchetypes();
  // Removed people leave the floor entirely (PRD §17.2); their positions settle from the portfolio.
  const blokes = (q.data?.data ?? []).filter((b) => b.status !== "delisted");
  const avg = useMemo(() => {
    const live = blokes.filter((b) => b.index);
    return live.length ? Math.round(live.reduce((s, b) => s + b.index!.b, 0) / live.length) : null;
  }, [blokes]);
  const trading = blokes.filter((b) => b.status === "live").length;
  const shown = blokes.filter(
    (b) =>
      (arch === null || b.archetype === arch) &&
      (filter === "all" ? true : filter === "live" ? b.status === "live" : filter === "shadow" ? b.status === "shadow" : b.badge === filter),
  );
  const archLabel = arch && archetypes.data?.data.find((a) => a.id === arch)?.role;

  return (
    <>
      <section className="grid items-center gap-10 pb-20 pt-10 md:grid-cols-[1fr_0.9fr] md:pt-16">
        <div>
          <motion.h1 {...enter()} className="display text-[clamp(42px,6.3vw,96px)] font-bold leading-[0.9]">
            <span className="whitespace-nowrap">Back the work.</span>
            <br />
            <span className="whitespace-nowrap text-ink-3">Short the noise.</span>
          </motion.h1>
          <motion.p {...enter(0.08)} className="mt-8 max-w-[42ch] text-lg leading-relaxed text-ink-2">
            Go long or short a builder. Every price follows a live index of what they ship and the attention around it.
          </motion.p>
          <motion.div {...enter(0.12)} className="mt-10 flex flex-wrap gap-3">
            <Link href="/me" className="btn btn-ink">
              Start with 10,000 tUSDC
            </Link>
            <a href="#floor" className="btn btn-quiet">
              See the floor
            </a>
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0, 0, 0.2, 1] }}>
          <Art slot="hero" priority className="w-full" />
        </motion.div>
      </section>

      <section aria-label="At a glance" className="grid grid-cols-3 border-y rule">
        <Figure label="Index of everyone" value={avg === null ? null : idx(avg)} loading={q.isLoading} />
        <Figure label="People listed" value={q.isLoading ? null : String(blokes.length)} loading={q.isLoading} />
        <Figure label="Trading now" value={q.isLoading ? null : String(trading)} loading={q.isLoading} />
      </section>

      <section aria-labelledby="arch-h" className="mt-20">
        <h2 id="arch-h" className="display text-4xl font-bold">
          Archetypes
        </h2>
        <ul className="-mx-4 mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 [scrollbar-width:none] md:-mx-0 md:px-0">
          {archetypes.isLoading || !archetypes.data
            ? Array.from({ length: 4 }, (_, i) => (
                <li key={i} className="w-[272px] shrink-0">
                  <ArchetypeCardSkeleton />
                </li>
              ))
            : archetypes.data.data.map((a) => (
                <li key={a.id} className="w-[272px] shrink-0 snap-start">
                  <ArchetypeCard
                    a={a}
                    selected={arch === a.id}
                    onSelect={() => {
                      setArch((cur) => (cur === a.id ? null : a.id));
                      document.getElementById("floor")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  />
                </li>
              ))}
        </ul>
      </section>

      {arch === "founder" && (
        <div className="mt-12">
          <HallOfFounders />
        </div>
      )}

      <section id="floor" aria-labelledby="floor-h" className="mt-16 grid scroll-mt-24 gap-14 lg:grid-cols-[1fr_300px]">
        <div>
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="floor-h" className="display text-4xl font-bold">
                The floor
              </h2>
              {archLabel && (
                <button type="button" onClick={() => setArch(null)} className="btn h-9 gap-2 bg-accent-wash px-4 text-sm text-deep" aria-label={`Clear ${archLabel} filter`}>
                  {archLabel} <span aria-hidden>×</span>
                </button>
              )}
            </div>
            <div role="radiogroup" aria-label="Filter" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn("h-10 rounded-full px-4 text-sm transition-colors duration-100 ease-out", filter === f.id ? "bg-ink text-canvas" : "text-ink-2 hover:bg-sand")}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-6 hidden grid-cols-[48px_minmax(0,1.4fr)_120px_minmax(0,1fr)_140px_110px] gap-x-5 border-b rule pb-3 text-[12px] text-ink-3 md:grid">
            <span />
            <span>Person</span>
            <span>Index</span>
            <span>Last 24 h</span>
            <span>Hype · Work</span>
            <span className="text-right">1 h</span>
          </div>
          {q.isError ? (
            <div className="mt-6 rounded-[28px] bg-sand p-10 text-center">
              <p className="text-ink-2">The floor didn&apos;t load.</p>
              <button type="button" onClick={() => q.refetch()} className="btn btn-ink mt-5">
                Try again
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {q.isLoading
                ? Array.from({ length: 4 }, (_, i) => <BlokeRowSkeleton key={i} />)
                : shown.length === 0
                  ? [
                      <li key="empty" className="py-12 text-center text-ink-2">
                        Nobody here yet.{" "}
                        <button
                          type="button"
                          onClick={() => {
                            setFilter("all");
                            setArch(null);
                          }}
                          className="text-accent-ink underline underline-offset-4"
                        >
                          Show everyone
                        </button>
                      </li>,
                    ]
                  : shown.map((b) => <BlokeRow key={b.id} b={b} />)}
            </ul>
          )}
        </div>
        <aside className="space-y-12 lg:pt-16">
          <Live />
          <How />
        </aside>
      </section>
    </>
  );
}

function Figure({ label, value, loading }: { label: string; value: string | null; loading: boolean }) {
  return (
    <div className="border-r rule py-7 pl-4 first:pl-0 last:border-r-0 md:pl-8">
      <p className="text-sm text-ink-3">{label}</p>
      {loading || value === null ? <div className="skeleton mt-3 h-9 w-24 rounded-full" /> : <p className="num display mt-2 text-4xl font-medium">{value}</p>}
    </div>
  );
}

function Live() {
  const items = useFeed(6);
  return (
    <section aria-labelledby="live-h">
      <h2 id="live-h" className="flex items-center gap-2 text-sm font-medium">
        Live trades
      </h2>
      {items.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-ink-3">Quiet right now. Trades appear here the moment they finalize on Monad.</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-line)] text-sm" aria-live="polite">
          {items.map((m, i) => {
            const e = m.event;
            if (e.type === "order")
              return (
                <li key={`o${e.orderId}${i}`} className="flex justify-between py-3">
                  <span className="text-ink-2">
                    Fill · <span className="num">{shortAddr(e.owner)}</span>
                  </span>
                  <span className="num">{e.fillPrice ? price(e.fillPrice) : "—"}</span>
                </li>
              );
            if (e.type === "lot") {
              const pnl = BigInt(e.pricePnl) + BigInt(e.fundingPnl);
              return (
                <li key={`l${e.lotId}${i}`} className="flex justify-between py-3">
                  <span className="text-ink-2">
                    Close · <span className="num">{shortAddr(e.owner)}</span>
                  </span>
                  <span className={cn("num", pnl >= 0n ? "text-pos" : "text-neg")}>{wadUsdc(pnl, { sign: true })}</span>
                </li>
              );
            }
            return null;
          })}
        </ul>
      )}
    </section>
  );
}

function How() {
  return (
    <section aria-labelledby="how-h">
      <h2 id="how-h" className="text-sm font-medium">
        How it works
      </h2>
      <p className="mt-4 text-sm leading-relaxed text-ink-2">
        Every person has three markets: the blend, <span className="text-ink">.HYPE</span> for attention and{" "}
        <span className="text-ink">.WORK</span> for what they ship. Go long or short with no leverage; your order fills at the next index update,
        about a second later.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">Opening is free. When you close, you keep your collateral plus PnL, minus 3% of any profit.</p>
    </section>
  );
}
