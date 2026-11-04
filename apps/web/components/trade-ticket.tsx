"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { decodeEventLog, parseSignature } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, CircleAlert, Loader2, Shuffle } from "lucide-react";
import { REJECT_MESSAGES, type BlokeDetail, type Leg, marketEngineAbi, monadTestnet, testUSDCAbi } from "@bloke/sdk";
import { qk, useAddresses, useStreamChannels } from "@/lib/api";
import { parseUsdc, price, pctWad, usdc } from "@/lib/format";
import { explain, useContractTx } from "@/lib/tx";
import { cn } from "@/lib/cn";

type Stage = "idle" | "permit" | "submitting" | "filling" | "filled" | "rejected" | "error";
const QUICK = [100, 500, 1000];
const SLIPPAGES = [50, 100, 300];
const MIN_GAS = 50_000_000_000_000_000n; // 0.05 MON (PRD §14.4)

/**
 * The ticket (PRD §14.3). One transaction with an EIP-2612 permit, then "Filling at next index update"
 * until the stream (or a chain read) reports Filled or Rejected. Every disabled state says why.
 */
export function TradeTicket({ bloke, leg, onLeg }: { bloke: BlokeDetail; leg: Leg; onLeg: (l: Leg) => void }) {
  const a = useAddresses();
  const { address, chainId, status } = useAccount();
  const { data: wallet } = useWalletClient();
  const pub = usePublicClient();
  const qc = useQueryClient();
  const tx = useContractTx();
  const market = bloke.markets.find((m) => m.leg === leg)!;
  const [side, setSide] = useState<1 | -1>(1);
  const [size, setSize] = useState("250");
  const [slip, setSlip] = useState(100);
  const [stage, setStage] = useState<Stage>("idle");
  const [orderId, setOrderId] = useState<bigint | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const collateral = parseUsdc(size);

  const mon = useBalance({ address, query: { enabled: !!address, refetchInterval: 15_000 } });
  const bal = useReadContract({ address: a?.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: !!a && !!address, refetchInterval: 10_000 } });
  const quote = useReadContract({
    address: a?.engine,
    abi: marketEngineAbi,
    functionName: "quote",
    args: [market.marketId, side, collateral ?? 0n],
    query: { enabled: !!a && collateral !== null, refetchInterval: 3_000 },
  });

  // Orders resolve on the stream; a chain read is the fallback if the socket is down.
  useStreamChannels(address ? [`orders:${address.toLowerCase()}`] : [], (m) => {
    if (m.event.type !== "order" || orderId === null || m.event.orderId !== orderId.toString()) return;
    if (m.event.status === "filled") finish("filled");
    if (m.event.status === "rejected") finish("rejected", REJECT_MESSAGES[m.event.reason ?? ""] ?? m.event.reason ?? "Rejected");
  });
  useEffect(() => {
    if (stage !== "filling" || orderId === null || !a || !pub) return;
    const t = setInterval(async () => {
      const o = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "order", args: [orderId] });
      if (o.status === 2) finish("filled");
      else if (o.status >= 3) finish("rejected", o.status === 3 ? "Rejected. Your tUSDC is back." : "Expired. Your tUSDC is back.");
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, orderId]);

  function finish(s: "filled" | "rejected", msg?: string) {
    setStage(s);
    setMessage(msg ?? null);
    if (address) qc.invalidateQueries({ queryKey: qk.wallet(address) });
    qc.invalidateQueries({ queryKey: qk.bloke(bloke.ticker) });
    bal.refetch();
  }

  const blocker = useMemo((): { text: string; href?: string } | null => {
    if (status !== "connected") return { text: "Connect a wallet to trade" };
    if (chainId !== monadTestnet.id) return { text: "Switch to Monad testnet" };
    if (market.status === "Shadow") return { text: "Opens after the shadow period" };
    if (market.status === "Frozen") return { text: "Frozen while under review" };
    if (market.status === "SettleOnly" || market.status === "Settled") return { text: "Settling at a fixed price" };
    if (bloke.index && !bloke.index.fresh) return { text: "Waiting for a fresh index" };
    if (mon.data && mon.data.value < MIN_GAS) return { text: "Get gas from the faucet", href: "/me" };
    if (bal.data === 0n) return { text: "Get 10,000 tUSDC", href: "/me" };
    if (collateral === null || collateral < 10_000_000n) return { text: "Minimum size is 10 tUSDC" };
    if (collateral > 5_000_000_000n) return { text: "Maximum is 5,000 tUSDC per market" };
    if (bal.data !== undefined && collateral > bal.data) return { text: "Not enough tUSDC" };
    return null;
  }, [status, chainId, market.status, bloke.index, mon.data, bal.data, collateral]);

  async function submit() {
    if (!a || !wallet || !address || !pub || collateral === null) return;
    setMessage(null);
    try {
      // One transaction: sign an EIP-2612 permit, then request with it (PRD F2).
      setStage("permit");
      const nonce = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "nonces", args: [address] });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const sig = await wallet.signTypedData({
        account: address,
        domain: { name: "BLOKE Test USDC", version: "1", chainId: monadTestnet.id, verifyingContract: a.tusdc },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: address, spender: a.engine, value: collateral, nonce, deadline },
      });
      const { r, s, v, yParity } = parseSignature(sig);
      setStage("submitting");
      const rc = await tx.send({
        address: a.engine,
        abi: marketEngineAbi,
        functionName: "requestOpenWithPermit",
        args: [market.marketId, side, collateral, slip, 0n, deadline, Number(v ?? BigInt(27 + (yParity ?? 0))), r, s],
      });
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: marketEngineAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "OrderRequested") setOrderId(ev.args.orderId);
        } catch {}
      }
      setStage("filling");
    } catch (err) {
      const msg = explain(err);
      setStage(msg ? "error" : "idle");
      setMessage(msg);
    }
  }

  async function spread(dir: 1 | -1) {
    if (!a || !wallet || !address || !pub || collateral === null) return;
    setMessage(null);
    try {
      setStage("submitting");
      const allowance = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "allowance", args: [address, a.engine] });
      if (allowance < collateral) await tx.send({ address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.engine, collateral] });
      const rc = await tx.send({ address: a.engine, abi: marketEngineAbi, functionName: "requestSpread", args: [bloke.id, dir, collateral, slip, 0n] });
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: marketEngineAbi, data: l.data, topics: l.topics });
          if (ev.eventName === "OrderRequested") {
            setOrderId(ev.args.orderId);
            break;
          }
        } catch {}
      }
      setStage("filling");
    } catch (err) {
      const msg = explain(err);
      setStage(msg ? "error" : "idle");
      setMessage(msg);
    }
  }

  const busy = stage === "permit" || stage === "submitting" || stage === "filling";
  const [fill, premiumAfter] = quote.data ?? [];
  const lagging = bloke.index ? ((bloke.index.lagFlags >> (2 * ["blend", "hype", "work"].indexOf(leg))) & 3) : 0;

  return (
    <section aria-labelledby="ticket-h" className="tile relative p-5">
      <h2 id="ticket-h" className="sr-only">
        Trade ${bloke.ticker}
      </h2>

      {/* Market: three legs */}
      <div role="tablist" aria-label="Market" className="rounded-full mb-4 grid grid-cols-3 gap-1 bg-canvas p-1">
        {(["blend", "hype", "work"] as Leg[]).map((l) => (
          <button
            key={l}
            role="tab"
            type="button"
            aria-selected={leg === l}
            onClick={() => onLeg(l)}
            className={cn("rounded-full relative h-10 text-sm transition-colors duration-100 ease-out", leg === l ? "text-canvas" : "text-ink-2 hover:text-ink")}
          >
            {leg === l && <motion.span layoutId="leg-rounded-full" className="rounded-full absolute inset-0 bg-ink" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
            <span className="relative">{l === "blend" ? `$${bloke.ticker}` : l === "hype" ? ".HYPE" : ".WORK"}</span>
          </button>
        ))}
      </div>

      {/* Side */}
      <div role="radiogroup" aria-label="Side" className="grid grid-cols-2 gap-2">
        {([1, -1] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            onClick={() => setSide(s)}
            className={cn(
              "flex h-14 items-center justify-center gap-2 rounded-[20px] text-base font-semibold transition-[background-color,box-shadow,transform] duration-100 ease-out active:scale-[0.98]",
              side === s
                ? s === 1
                  ? "bg-accent-ink text-white"
                  : "bg-berry text-white"
                : "bg-canvas text-ink-2 hover:bg-sand-2",
            )}
          >
            {s === 1 ? <ArrowUpRight className="size-5" aria-hidden /> : <ArrowDownRight className="size-5" aria-hidden />}
            {s === 1 ? "Long" : "Short"}
          </button>
        ))}
      </div>

      {/* Size */}
      <label htmlFor="size" className="mt-5 flex items-center justify-between text-sm">
        <span className="text-ink-2">Size</span>
        <span className="text-xs text-ink-3">
          Balance <span className="num text-ink-2">{usdc(bal.data)}</span> tUSDC
        </span>
      </label>
      <div className="mt-2 flex items-center rounded-[20px] bg-white px-4 shadow-[inset_0_0_0_1px_#E4E0DC] focus-within:shadow-[inset_0_0_0_2px_#5B44E8]">
        <input
          id="size"
          inputMode="decimal"
          autoComplete="off"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          aria-invalid={collateral === null}
          className="num h-14 w-full bg-transparent text-2xl outline-none placeholder:text-ink-3"
          placeholder="0"
        />
        <span className="text-sm text-ink-3">tUSDC</span>
      </div>
      <div className="mt-2 flex gap-2">
        {QUICK.map((q) => (
          <button key={q} type="button" onClick={() => setSize(String(q))} className="rounded-full h-9 flex-1 bg-canvas text-sm text-ink-2 hover:bg-sand-2 hover:text-ink">
            <span className="num">{q.toLocaleString()}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => bal.data !== undefined && setSize(String(Math.min(5000, Number(bal.data) / 1e6)))}
          className="rounded-full h-9 flex-1 bg-canvas text-sm text-ink-2 hover:bg-sand-2 hover:text-ink"
        >
          Max
        </button>
      </div>

      {/* Preview from engine.quote (PRD §14.3 step 2) */}
      <dl className="mt-5 space-y-2 rounded-[20px] bg-canvas p-4 text-sm">
        <Row k="Estimated fill" v={fill !== undefined ? price(fill) : "—"} />
        <Row k="Premium after" v={premiumAfter !== undefined ? pctWad(premiumAfter) : "—"} />
        <Row k="Fee" v="3% of profit at close" />
        <div className="flex items-center justify-between">
          <dt className="text-ink-2">Slippage</dt>
          <dd role="radiogroup" aria-label="Slippage" className="flex gap-1">
            {SLIPPAGES.map((b) => (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={slip === b}
                onClick={() => setSlip(b)}
                className={cn("rounded-full num h-8 px-3 text-xs", slip === b ? "bg-ink text-canvas" : "bg-canvas text-ink-2 hover:text-ink")}
              >
                {b / 100}%
              </button>
            ))}
          </dd>
        </div>
      </dl>

      {lagging !== 0 && (
        <p className="mt-3 rounded-[16px] bg-berry-wash px-4 py-3 text-xs text-berry">
          The index is catching up {lagging === 1 ? "upward" : "downward"}. {lagging === 1 ? "Longs" : "Shorts"} pause until it does, so nobody trades a move
          that&apos;s already known.
        </p>
      )}

      {blocker?.href ? (
        <Link href={blocker.href} className="btn btn-ink mt-5 h-14 w-full text-base">
          {blocker.text}
        </Link>
      ) : (
        <button
          type="button"
          disabled={!!blocker || busy}
          aria-busy={busy}
          onClick={submit}
          className={cn(
            "rounded-full mt-5 flex h-14 w-full items-center justify-center gap-2 text-base font-semibold transition-[transform,filter] duration-100 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
            side === 1 ? "bg-accent-ink text-white" : "bg-berry text-white",
          )}
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {blocker?.text ??
            (stage === "permit"
              ? "Sign the permit…"
              : stage === "submitting"
                ? "Confirm in wallet…"
                : stage === "filling"
                  ? "Filling at next index update"
                  : `${side === 1 ? "Long" : "Short"} ${leg === "blend" ? `$${bloke.ticker}` : leg === "hype" ? ".HYPE" : ".WORK"}`)}
        </button>
      )}

      <AnimatePresence>
        {(stage === "filled" || stage === "rejected" || stage === "error") && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            role="status"
            className={cn(
              "mt-3 flex items-start gap-2 rounded-[16px] px-4 py-3 text-sm",
              stage === "filled" ? "bg-pos/10 text-pos" : "bg-neg/10 text-neg",
            )}
          >
            {stage === "filled" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span>
              {stage === "filled" ? (
                <>
                  Filled. See it in{" "}
                  <Link href="/portfolio" className="underline underline-offset-4">
                    your portfolio
                  </Link>
                  .
                </>
              ) : (
                message
              )}
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      {/* One-tap spreads (PRD F3) */}
      <div className="mt-5 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-5">
        <SpreadButton label="Underrated" hint="Long .WORK, short .HYPE" onClick={() => spread(1)} disabled={!!blocker || busy} />
        <SpreadButton label="All talk" hint="Long .HYPE, short .WORK" onClick={() => spread(-1)} disabled={!!blocker || busy} />
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-2">{k}</dt>
      <dd className="num">{v}</dd>
    </div>
  );
}

function SpreadButton({ label, hint, onClick, disabled }: { label: string; hint: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex flex-col items-start gap-1 rounded-[20px] bg-canvas px-4 py-3 text-left transition-[background-color,transform] duration-100 ease-out hover:bg-sand-2 active:scale-[0.98] disabled:opacity-50"
    >
      <span className="flex items-center gap-1.5 font-semibold">
        <Shuffle className="size-3.5 text-accent-ink" aria-hidden />
        {label}
      </span>
      <span className="text-xs text-ink-3">{hint}</span>
    </button>
  );
}
