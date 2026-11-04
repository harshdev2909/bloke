"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { ARCHETYPES, type ArchetypeId, ApiError, blokeRaiseAbi, blokeRegistryAbi } from "@bloke/sdk";
import { api, useAddresses } from "@/lib/api";
import { useEnsureSession } from "@/lib/session";
import { useContractTx } from "@/lib/tx";
import { parseUsdc } from "@/lib/format";
import { cn } from "@/lib/cn";
import { WalletButton } from "./wallet-button";

/**
 * Start your own raise (A18): list yourself, claim the profile and open the raise, three steps from
 * one form. Staging lists instantly; the event set routes the same request to operator review.
 */
export function StartRaise() {
  const { address } = useAccount();
  const a = useAddresses();
  const tx = useContractTx();
  const ensure = useEnsureSession();
  const router = useRouter();
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [archetype, setArchetype] = useState<ArchetypeId>("founder");
  const [goal, setGoal] = useState("10000");
  const [days, setDays] = useState("7");
  const [step, setStep] = useState<null | "list" | "claim" | "open">(null);
  const [err, setErr] = useState<string | null>(null);
  const wallet = useQuery({ queryKey: ["wallet", address], queryFn: () => api.wallet(address!), enabled: !!address });
  const profile = wallet.data?.data.profiles[0];
  const goalV = parseUsdc(goal);
  const t = ticker.trim().toUpperCase();
  const valid = /^[A-Z0-9]{2,10}$/.test(t) && name.trim().length >= 2 && goalV !== null && goalV >= 1_000_000_000n && Number(days) >= 1 && Number(days) <= 30;

  const go = async () => {
    if (!a?.raise || !address) return;
    setErr(null);
    try {
      setStep("list");
      await ensure();
      const { data: c } = await api.startRaise({ ticker: t, name: name.trim(), archetype });
      setStep("claim");
      await tx.send({ address: a.registry, abi: blokeRegistryAbi, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });
      setStep("open");
      const minCommit = goalV! / 100n > 10_000_000n ? 10_000_000n : goalV! / 100n;
      await tx.send({ address: a.raise, abi: blokeRaiseAbi, functionName: "open", args: [c.blokeId, goalV!, BigInt(Math.round(Number(days) * 86_400)), minCommit] });
      router.push(`/b/${t}#raise`);
    } catch (e) {
      setStep(null);
      if (!tx.error) setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  };

  if (!address) {
    return (
      <Shell>
        <p className="text-ink-2">Connect a wallet to start your own raise.</p>
        <div className="mt-5">
          <WalletButton />
        </div>
      </Shell>
    );
  }
  if (profile) {
    return (
      <Shell>
        <p className="text-ink-2">
          Your profile is <span className="font-semibold text-ink">${profile.ticker}</span>.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={`/b/${profile.ticker}#raise`} className="btn btn-accent">
            Open your raise
          </Link>
          <Link href={`/b/${profile.ticker}#pow-h`} className="btn btn-quiet">
            Add proof of work
          </Link>
        </div>
      </Shell>
    );
  }
  const busy = step !== null;
  return (
    <Shell>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink-2">
          Ticker
          <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} maxLength={10} placeholder="ADA" autoComplete="off" className="field num mt-1 uppercase" />
        </label>
        <label className="text-sm text-ink-2">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Your name" autoComplete="name" className="field mt-1" />
        </label>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm text-ink-2">What you do</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ARCHETYPES.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={archetype === x.id}
              onClick={() => setArchetype(x.id)}
              className={cn("h-10 rounded-full px-4 text-sm transition-colors duration-100", archetype === x.id ? "bg-ink text-canvas" : "bg-canvas text-ink-2 hover:bg-sand-2")}
            >
              {x.numeral} · {x.role.replace("The ", "")}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <label className="text-sm text-ink-2">
          Goal (tUSDC)
          <input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} autoComplete="off" className="field num mt-1" />
        </label>
        <label className="text-sm text-ink-2">
          Days open
          <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} autoComplete="off" className="field num mt-1" />
        </label>
      </div>
      <button type="button" disabled={!valid || busy} onClick={go} className="btn btn-accent mt-6 w-full">
        {step === "list" ? "Listing you…" : step === "claim" ? "Claim in your wallet…" : step === "open" ? "Open the raise in your wallet…" : "Start my raise"}
      </button>
      <p className="mt-3 text-xs text-ink-3">Two wallet confirmations: claim your profile, then open the raise. Goal 1,000–1,000,000 tUSDC, 1–30 days.</p>
      {(tx.error || err) && (
        <p role="alert" className="mt-2 text-sm text-neg">
          {tx.error ?? err}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="start-h" className="tile scroll-mt-28 p-7">
      <h2 id="start-h" className="display scroll-mt-28 text-2xl font-bold">
        Start your raise
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
