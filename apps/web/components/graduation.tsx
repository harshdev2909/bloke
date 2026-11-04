"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleDashed, ExternalLink } from "lucide-react";
import { type BlokeDetail, type GraduationView, blokeDeskAbi, blokeV2RouterAbi, graduationLauncherAbi, monadTestnet, testUSDCAbi } from "@bloke/sdk";
import { api, qk, useAddresses } from "@/lib/api";
import { useEnsureSession } from "@/lib/session";
import { useContractTx } from "@/lib/tx";
import { parseUsdc } from "@/lib/format";
import { cn } from "@/lib/cn";

const WAD = 10n ** 18n;
const explorer = (addr: string) => `${monadTestnet.blockExplorers!.default.url}/address/${addr}`;

/** Compact token amounts: 18 dp → "150M", "4.2K", "12.5". */
export function tokens(raw: string | bigint, dp = 18): string {
  const n = Number(BigInt(raw) / 10n ** BigInt(Math.max(0, dp - 6))) / 1e6;
  return n.toLocaleString("en-US", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: n >= 1 ? 2 : 6 });
}

export function useGraduation(ticker: string) {
  return useQuery({ queryKey: ["graduation", ticker], queryFn: () => api.graduation(ticker), refetchInterval: 15_000 });
}

/** The checklist before graduation; the token, pool and allocations after it (PRD §10). */
export function GraduationPanel({ b }: { b: BlokeDetail }) {
  const g = useGraduation(b.ticker);
  if (g.data?.data.graduated) return <TokenPanel b={b} g={g.data.data} />;
  return <Checklist b={b} />;
}

function Checklist({ b }: { b: BlokeDetail }) {
  const { address } = useAccount();
  const passed = b.graduation.checks.filter((c) => c.available && c.pass).length;
  const total = b.graduation.checks.length;
  const ready = passed === total;
  const mine = !!address && !!b.claimedWallet && address.toLowerCase() === b.claimedWallet.toLowerCase();
  return (
    <section aria-labelledby="grad-h" className="tile p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="grad-h" className="display text-lg font-bold">
          Graduation
        </h2>
        <span className="num text-sm text-ink-2">
          {passed}/{total} checks
        </span>
      </div>
      <div className="mb-5 h-2 overflow-hidden rounded-full bg-sand-2" aria-hidden>
        <motion.div
          className="h-full rounded-full bg-accent-ink"
          initial={{ width: 0 }}
          animate={{ width: `${(passed / total) * 100}%` }}
          transition={{ duration: 0.4, ease: [0, 0, 0.2, 1] }}
        />
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {b.graduation.checks.map((c) => (
          <li key={c.name} className={cn("flex items-start gap-3 rounded-[18px] bg-canvas px-4 py-3 text-sm", !c.available && "opacity-60")}>
            {!c.available ? (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
            ) : c.pass ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-pos" aria-hidden />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-ink-2" aria-hidden />
            )}
            <span>
              <span className="block font-medium">{c.name}</span>
              <span className="num text-xs text-ink-3">{c.available ? `${c.value} · needs ${c.threshold}` : "Not on this deployment"}</span>
            </span>
          </li>
        ))}
      </ul>
      {mine && <GraduateButton ticker={b.ticker} ready={ready} />}
    </section>
  );
}

export function GraduateButton({ ticker, ready, label = "Graduate" }: { ticker: string; ready: boolean; label?: string }) {
  const a = useAddresses();
  const tx = useContractTx();
  const ensure = useEnsureSession();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!a?.launcher) return;
    setErr(null);
    setBusy(true);
    try {
      await ensure();
      const { data } = await api.attestGraduation(ticker);
      const at = data.attestation;
      await tx.send({
        address: a.launcher,
        abi: graduationLauncherAbi,
        functionName: "graduate",
        args: [
          {
            blokeId: at.blokeId,
            traderCount: at.traderCount,
            airdropRoot: at.airdropRoot,
            airdropTotal: BigInt(at.airdropTotal),
            backerRoot: at.backerRoot,
            backerTotal: BigInt(at.backerTotal),
            nonce: BigInt(at.nonce),
            expiry: BigInt(at.expiry),
          },
          data.signature,
        ],
      });
      await Promise.all([qc.invalidateQueries({ queryKey: ["graduation", ticker] }), qc.invalidateQueries({ queryKey: qk.bloke(ticker) })]);
    } catch (e) {
      if (!tx.error) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-5">
      <button type="button" disabled={!ready || busy || !a?.launcher} onClick={go} className="btn btn-accent w-full">
        {busy ? "Confirm in wallet…" : ready ? label : `${label} when every check passes`}
      </button>
      {(tx.error || err) && (
        <p role="alert" className="mt-2 text-sm text-neg">
          {tx.error ?? err}
        </p>
      )}
    </div>
  );
}

function TokenPanel({ b, g }: { b: BlokeDetail; g: GraduationView }) {
  const unlock = g.lock ? new Date(g.lock.unlockAt) : null;
  return (
    <section aria-labelledby="tok-h" className="tile p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="tok-h" className="display text-lg font-bold">
          ${g.symbol} token
        </h2>
        <a href={explorer(g.token!)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-accent-ink underline-offset-4 hover:underline">
          <span className="num">{g.token!.slice(0, 6)}…{g.token!.slice(-4)}</span>
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fig label="Price" value={`${tokens(g.price!.tbloke)} tBLOKE`} sub={`${(Number(g.price!.usdc) / 1e6).toFixed(6)} tUSDC`} />
        <Fig label="Pool" value={`${tokens(g.reserves!.token)}`} sub={`${tokens(g.reserves!.tbloke)} tBLOKE`} />
        <Fig label="LP locked until" value={unlock ? unlock.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"} sub={`${(g.lock!.personBps / 100).toFixed(0)}% to the person`} />
        <Fig label="Vesting" value={`${tokens(g.vesting!.claimed)} / 150M`} sub={`cliff ends ${new Date(g.vesting!.cliffEnds).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Alloc label="Early longs" d={g.airdrop!} />
        <Alloc label="Backers" d={g.backer!} />
      </div>
      <Swap b={b} g={g} />
      <p className="mt-4 text-xs text-ink-3">
        The perpetual markets keep pricing off the index. Token price and index are not linked.{" "}
        <Link href="/me" className="text-accent-ink underline underline-offset-4">
          Your claims
        </Link>
      </p>
    </section>
  );
}

function Fig({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[20px] bg-canvas px-4 py-3">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="num mt-1 font-medium">{value}</p>
      {sub && <p className="num text-xs text-ink-3">{sub}</p>}
    </div>
  );
}

function Alloc({ label, d }: { label: string; d: NonNullable<GraduationView["airdrop"]> }) {
  const pct = Number((BigInt(d.claimed) * 1000n) / BigInt(d.total)) / 10;
  return (
    <div className="rounded-[20px] bg-canvas px-4 py-3">
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="num text-ink-3">{pct}% claimed</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sand" aria-hidden>
        <div className="h-full rounded-full bg-accent-ink" style={{ width: `${pct}%` }} />
      </div>
      <p className="num mt-2 text-xs text-ink-3">
        {tokens(d.total)} · closes {new Date(d.deadline).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
      </p>
    </div>
  );
}

/** tUSDC → tBLOKE at the desk → $NAME through the pool, or $NAME → tBLOKE. */
function Swap({ g }: { b: BlokeDetail; g: GraduationView }) {
  const a = useAddresses();
  const { address } = useAccount();
  const tx = useContractTx();
  const qc = useQueryClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("100");
  const usdcIn = parseUsdc(amount);
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  const run = async () => {
    if (!a?.desk || !a.v2Router || !a.tbloke || !address || usdcIn === null || usdcIn === 0n) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    try {
      if (side === "buy") {
        const tIn = (usdcIn * WAD) / BigInt(g.price!.deskUsdcPerTbloke);
        await tx.send({ address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.desk, usdcIn] });
        await tx.send({ address: a.desk, abi: blokeDeskAbi, functionName: "buy", args: [usdcIn, tIn] });
        await tx.send({ address: a.tbloke, abi: testUSDCAbi, functionName: "approve", args: [a.v2Router, tIn] });
        await tx.send({ address: a.v2Router, abi: blokeV2RouterAbi, functionName: "swapExactTokensForTokens", args: [tIn, 0n, [a.tbloke, g.token!], address, deadline] });
      } else {
        // Sell: the amount is in tokens.
        const tokIn = usdcIn * 10n ** 12n;
        await tx.send({ address: g.token!, abi: testUSDCAbi, functionName: "approve", args: [a.v2Router, tokIn] });
        await tx.send({ address: a.v2Router, abi: blokeV2RouterAbi, functionName: "swapExactTokensForTokens", args: [tokIn, 0n, [g.token!, a.tbloke], address, deadline] });
      }
      qc.invalidateQueries({ queryKey: ["graduation"] });
    } catch {
      // tx.error explains
    }
  };
  return (
    <div className="mt-5 rounded-[24px] bg-canvas p-4">
      <div role="radiogroup" aria-label="Swap side" className="inline-flex rounded-full bg-sand p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={side === s} onClick={() => setSide(s)} className={cn("h-9 rounded-full px-4 text-sm capitalize", side === s ? "bg-ink text-canvas" : "text-ink-2")}>
            {s}
          </button>
        ))}
      </div>
      <label htmlFor="swap-amt" className="mt-3 block text-xs text-ink-3">
        {side === "buy" ? "tUSDC to spend" : `$${g.symbol} to sell`}
      </label>
      <input id="swap-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="field num mt-1" />
      <button type="button" disabled={busy || usdcIn === null || usdcIn === 0n || !a?.v2Router} onClick={run} className="btn btn-ink mt-3 w-full">
        {busy ? "Confirm in wallet…" : side === "buy" ? `Buy $${g.symbol}` : `Sell for tBLOKE`}
      </button>
      {tx.error && <p className="mt-2 text-sm text-neg">{tx.error}</p>}
    </div>
  );
}
