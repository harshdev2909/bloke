"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type BlokeDetail, type RaiseView, ARCHETYPES, blokeRaiseAbi, testUSDCAbi } from "@bloke/sdk";
import { api, useAddresses } from "@/lib/api";
import { useContractTx } from "@/lib/tx";
import { parseUsdc, usdc } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Sigil } from "./sigil";
import { GraduateButton, tokens, useGraduation } from "./graduation";

export function useRaise(ticker: string) {
  const { address } = useAccount();
  return useQuery({ queryKey: ["raise", ticker, address], queryFn: () => api.raise(ticker, address), refetchInterval: 10_000 });
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function timeLeft(deadline: string, now: number): string {
  const s = Math.max(0, Math.floor((Date.parse(deadline) - now) / 1000));
  if (s === 0) return "ended";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

export function Progress({ r, className }: { r: RaiseView; className?: string }) {
  const pct = Math.min(100, Number((BigInt(r.raised) * 1000n) / BigInt(r.goal)) / 10);
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="num font-medium">{usdc(r.raised, { compact: true })}</span>
        <span className="num text-ink-3">of {usdc(r.goal, { compact: true })}</span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-sand-2" aria-label={`${pct}% raised`}>
        <div className={cn("h-full rounded-full transition-[width] duration-500", r.state === "failed" || r.state === "cancelled" ? "bg-ink-3" : "bg-accent-ink")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const STATE_LABEL: Record<RaiseView["state"], string> = {
  open: "Open",
  succeeded: "Funded",
  withdrawn: "Funded",
  failed: "Ended below goal",
  cancelled: "Cancelled",
};

/** One raise on the Raise page. */
export function RaiseCard({ r }: { r: RaiseView }) {
  const now = useNow(30_000);
  const arch = ARCHETYPES.find((a) => a.id === r.archetype);
  return (
    <Link href={`/b/${r.ticker}#raise`} className="tile block p-6 transition-transform duration-150 ease-out hover:-translate-y-0.5">
      <div className="flex items-center gap-3">
        <Sigil ticker={r.ticker} size={40} />
        <div className="min-w-0">
          <p className="truncate font-semibold">${r.ticker}</p>
          <p className="truncate text-sm text-ink-3">{arch ? `${arch.numeral} · ${arch.role}` : r.name}</p>
        </div>
        <span className={cn("ml-auto rounded-full px-3 py-1 text-xs", r.state === "open" ? "bg-accent-wash text-deep" : "bg-canvas text-ink-2")}>{STATE_LABEL[r.state]}</span>
      </div>
      <Progress r={r} className="mt-5" />
      <p className="num mt-3 text-xs text-ink-3">
        {r.backers} {r.backers === 1 ? "backer" : "backers"} · {r.state === "open" ? timeLeft(r.deadline, now) : new Date(r.deadline).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
      </p>
    </Link>
  );
}

/** Raise on a Bloke's page: back an open raise, refund a failed one, or (the person) run one. */
export function RaisePanel({ b }: { b: BlokeDetail }) {
  const q = useRaise(b.ticker);
  const { address } = useAccount();
  const a = useAddresses();
  const tx = useContractTx();
  const qc = useQueryClient();
  const now = useNow();
  const [amount, setAmount] = useState("250");
  const [goal, setGoal] = useState("10000");
  const [days, setDays] = useState("7");
  const r = q.data?.data ?? null;
  const mine = !!address && !!b.claimedWallet && address.toLowerCase() === b.claimedWallet.toLowerCase();
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  const value = parseUsdc(amount);
  const goalV = parseUsdc(goal);
  const open = r?.state === "open";
  const committed = r?.committed ? BigInt(r.committed) : 0n;

  const run = async (call: () => Promise<unknown>) => {
    try {
      await call();
      await qc.invalidateQueries({ queryKey: ["raise", b.ticker] });
    } catch {
      // tx.error explains
    }
  };
  if (!a?.raise) return null;
  if (!r && !mine && b.status !== "graduated") return null;

  return (
    <section id="raise" aria-labelledby="raise-h" className="tile scroll-mt-28 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="raise-h" className="display text-lg font-bold">
          Raise
        </h2>
        {r && <span className="num text-sm text-ink-2">{open ? timeLeft(r.deadline, now) : STATE_LABEL[r.state]}</span>}
      </div>

      {r && (
        <>
          <Progress r={r} className="mt-4" />
          <p className="num mt-2 text-xs text-ink-3">
            {r.backers} {r.backers === 1 ? "backer" : "backers"} · min {usdc(r.minCommit)} · all or nothing
          </p>
        </>
      )}

      {r && open && !mine && (
        <div className="mt-4 flex gap-2">
          <label htmlFor="raise-amt" className="sr-only">
            tUSDC to commit
          </label>
          <input id="raise-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="field num flex-1" />
          <button
            type="button"
            disabled={busy || !address || value === null || value === 0n}
            onClick={() =>
              run(async () => {
                await tx.send({ address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.raise!, value!] });
                await tx.send({ address: a.raise!, abi: blokeRaiseAbi, functionName: "commit", args: [BigInt(r.id), value!] });
              })
            }
            className="btn btn-accent px-6"
          >
            {busy ? "Confirm…" : "Back"}
          </button>
        </div>
      )}

      {r && committed > 0n && (
        <div className="mt-4 flex items-center justify-between rounded-[18px] bg-canvas px-4 py-3 text-sm">
          <span>
            You backed <span className="num font-medium">{usdc(committed.toString())}</span>
          </span>
          {(r.state === "failed" || r.state === "cancelled") && (
            <button type="button" disabled={busy} onClick={() => run(() => tx.send({ address: a.raise!, abi: blokeRaiseAbi, functionName: "refund", args: [BigInt(r.id)] }))} className="btn btn-ink h-9 px-4 text-sm">
              Refund
            </button>
          )}
        </div>
      )}

      {mine && r && open && (
        <button type="button" disabled={busy} onClick={() => run(() => tx.send({ address: a.raise!, abi: blokeRaiseAbi, functionName: "cancel", args: [BigInt(r.id)] }))} className="btn btn-quiet mt-4 w-full">
          Cancel raise
        </button>
      )}
      {mine && r?.state === "succeeded" && (
        <button type="button" disabled={busy} onClick={() => run(() => tx.send({ address: a.raise!, abi: blokeRaiseAbi, functionName: "withdraw", args: [BigInt(r.id)] }))} className="btn btn-accent mt-4 w-full">
          Withdraw {usdc(r.raised)}
        </button>
      )}

      {mine && (!r || (!open && r.state !== "succeeded")) && (
        <div className="mt-4 grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-ink-3">
              Goal (tUSDC)
              <input inputMode="decimal" autoComplete="off" value={goal} onChange={(e) => setGoal(e.target.value)} className="field num mt-1" />
            </label>
            <label className="text-xs text-ink-3">
              Days
              <input inputMode="numeric" autoComplete="off" value={days} onChange={(e) => setDays(e.target.value)} className="field num mt-1" />
            </label>
          </div>
          <button
            type="button"
            disabled={busy || goalV === null || !(Number(days) >= 1 && Number(days) <= 30)}
            onClick={() =>
              run(() =>
                tx.send({
                  address: a.raise!,
                  abi: blokeRaiseAbi,
                  functionName: "open",
                  args: [b.id, goalV!, BigInt(Math.round(Number(days) * 86_400)), goalV! / 100n > 10_000_000n ? 10_000_000n : goalV! / 100n],
                }),
              )
            }
            className="btn btn-ink w-full"
          >
            {busy ? "Confirm in wallet…" : "Open a raise"}
          </button>
        </div>
      )}
      {tx.error && <p className="mt-2 text-sm text-neg">{tx.error}</p>}
      <LaunchStep b={b} mine={mine} />
    </section>
  );
}

/**
 * Launch the token: the end of a raise. Graduation deploys the person's token, seeds and locks its
 * pool, and gives raise backers their share of the backer allocation (A18).
 */
function LaunchStep({ b, mine }: { b: BlokeDetail; mine: boolean }) {
  const g = useGraduation(b.ticker);
  const view = g.data?.data;
  const passed = b.graduation.checks.filter((c) => c.available && c.pass).length;
  const total = b.graduation.checks.length;
  if (view?.graduated) {
    return (
      <Link href={`/b/${b.ticker}#tok-h`} className="mt-4 flex items-center justify-between rounded-[18px] bg-accent-wash px-4 py-3 text-sm text-deep">
        <span>
          <span className="font-semibold">${view.symbol}</span> launched
        </span>
        <span className="num">{tokens(view.price!.tbloke)} tBLOKE</span>
      </Link>
    );
  }
  if (!mine) return null;
  return (
    <div className="mt-5 border-t rule pt-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">Launch token</span>
        <a href="#grad-h" className="num text-ink-3 underline-offset-4 hover:underline">
          {passed}/{total} checks
        </a>
      </div>
      <GraduateButton ticker={b.ticker} ready={passed === total} label={`Launch $${b.ticker}`} />
    </div>
  );
}
