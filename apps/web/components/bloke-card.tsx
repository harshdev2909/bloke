"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { BlokeSummary } from "@bloke/sdk";
import { api, qk, useDirection } from "@/lib/api";
import { delta, idx } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Sigil } from "./sigil";
import { Sparkline } from "./gauges";

export function Badge({ kind }: { kind: BlokeSummary["badge"] }) {
  if (!kind) return null;
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-[12px]", kind === "underrated" ? "bg-accent-wash text-accent-ink" : "bg-berry-wash text-berry")}>
      {kind === "underrated" ? "Underrated" : "Overhyped"}
    </span>
  );
}

export function Change({ v }: { v: number | null }) {
  if (v === null) return <span className="num text-ink-3">—</span>;
  const up = v > 500;
  const down = v < -500;
  return (
    <span className={cn("num inline-flex items-center gap-0.5", up ? "text-pos" : down ? "text-neg" : "text-ink-3")}>
      {up && <ArrowUpRight className="size-3.5" aria-hidden />}
      {down && <ArrowDownRight className="size-3.5" aria-hidden />}
      {delta(v)}
      <span className="sr-only">{up ? "up" : down ? "down" : "flat"} in the last hour</span>
    </span>
  );
}

/** One person per row: mark, name, the number, its last day, and the balance of its two legs. */
export function BlokeRow({ b }: { b: BlokeSummary }) {
  const series = useQuery({ queryKey: qk.index(b.ticker, "blend", "24h"), queryFn: () => api.index(b.ticker, { range: "24h" }), staleTime: 60_000 });
  const dir = useDirection(b.index?.b);
  const pts = series.data?.data.map((p) => p.b) ?? [];
  const h = b.index?.h ?? 0;
  const w = b.index?.w ?? 0;
  const workShare = h + w > 0 ? (w / (h + w)) * 100 : 50;
  return (
    <li>
      <Link
        href={`/b/${b.ticker}`}
        className="group -mx-4 grid grid-cols-[48px_1fr_auto] items-center gap-x-5 gap-y-2 rounded-[24px] px-4 py-5 transition-colors duration-100 ease-out hover:bg-sand md:grid-cols-[48px_minmax(0,1.4fr)_120px_minmax(0,1fr)_140px_110px]"
      >
        <Sigil ticker={b.ticker} h={b.index?.h} w={b.index?.w} size={48} className="transition-transform duration-300 ease-out group-hover:rotate-12" />
        <div className="min-w-0">
          <p className="display flex items-center gap-2 text-lg font-semibold leading-tight">
            ${b.ticker}
            {b.status === "shadow" ? <span className="rounded-full bg-sand-2 px-2 py-0.5 text-[11px] font-normal tracking-normal text-ink-2">Shadow</span> : <Badge kind={b.badge} />}
          </p>
          <p className="truncate text-sm text-ink-3">{b.name}</p>
        </div>
        <p className={cn("num display text-right text-[28px] font-medium leading-none md:text-left", dir === "up" && "flash-up", dir === "down" && "flash-down")}>{idx(b.index?.b)}</p>
        <div className="col-span-3 md:col-span-1">
          {series.isLoading ? (
            <div className="skeleton h-9 rounded-full" />
          ) : pts.length < 2 ? (
            <p className="flex h-9 items-center text-[13px] text-ink-3">{b.index ? "Building history" : "Not pushed yet"}</p>
          ) : (
            <Sparkline values={pts} className="h-9 w-full" />
          )}
        </div>
        {!b.index ? (
          <p className="hidden text-[13px] text-ink-3 md:block">—</p>
        ) : (
        <div className="hidden md:block" aria-label={`HYPE ${idx(h)}, WORK ${idx(w)}`}>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-sand-2">
            <span className="bg-berry" style={{ width: `${100 - workShare}%` }} />
            <span className="bg-accent-ink" style={{ width: `${workShare}%` }} />
          </div>
          <p className="mt-1.5 flex justify-between text-[12px] text-ink-3">
            <span>
              H <span className="num">{idx(h)}</span>
            </span>
            <span>
              W <span className="num">{idx(w)}</span>
            </span>
          </p>
        </div>
        )}
        <p className="hidden text-right md:block">
          <Change v={b.change1h} />
        </p>
      </Link>
    </li>
  );
}

export function BlokeRowSkeleton() {
  return (
    <li className="flex items-center gap-5 py-5" aria-hidden>
      <div className="skeleton size-12 rounded-full" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-4 w-28 rounded-full" />
        <div className="skeleton h-3 w-40 rounded-full" />
      </div>
      <div className="skeleton h-7 w-20 rounded-full" />
    </li>
  );
}
