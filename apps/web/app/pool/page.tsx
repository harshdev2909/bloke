"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { blokePoolAbi, testUSDCAbi } from "@bloke/sdk";
import { api, qk, useAddresses } from "@/lib/api";
import { parseUsdc, usdc } from "@/lib/format";
import { useContractTx } from "@/lib/tx";
import { Art } from "@/components/art";
import { cn } from "@/lib/cn";

/** EDGE has 12 decimals (6 more than tUSDC, from the pool's virtual-share offset). */
const EDGE_EXTRA = 10n ** 6n;
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

export default function PoolPage() {
  const q = useQuery({ queryKey: qk.pool, queryFn: () => api.pool(), refetchInterval: 10_000 });
  const ep = useQuery({ queryKey: ["epochs"], queryFn: () => api.epochs(12), refetchInterval: 30_000 });
  const p = q.data?.data;
  const F = p ? BigInt(p.floor.value) : 0n;
  const E = p ? BigInt(p.edge.nav) : 0n;
  const R = p ? BigInt(p.reserve) : 0n;
  const total = F + E + R;

  return (
    <div className="mt-10">
      <div className="grid items-end gap-10 md:grid-cols-[1fr_320px]">
        <div>
          <h1 className="display text-5xl font-bold md:text-6xl">The pool</h1>
          <p className="mt-4 max-w-[46ch] text-lg text-ink-2">Every trade&apos;s counterparty. Back it from the senior Floor or the junior Edge.</p>
        </div>
        <Art slot="pool" className="hidden w-full md:block" sizes="320px" />
      </div>

      <section aria-label="Capital stack" className="mt-14 grid gap-3">
        {[
          { name: "Edge", note: "Junior · takes the residual each hour", v: E, color: "bg-accent-ink" },
          { name: "Reserve", note: "Protects Floor before principal", v: R, color: "bg-deep" },
          { name: "Floor", note: p?.floor.active ? `Senior · ${pct(p.floor.active.rateBps)} fixed` : "Senior · fixed rate", v: F, color: "bg-ink-3" },
        ].map((l) => (
          <div key={l.name} className="grid grid-cols-[90px_1fr] items-center gap-5 md:grid-cols-[110px_1fr_260px]">
            <div>
              <p className="font-medium">{l.name}</p>
              <p className="num text-sm text-ink-3">{p ? usdc(l.v.toString(), { compact: true }) : "—"}</p>
            </div>
            <div className="h-12 overflow-hidden rounded-full bg-sand">
              <div
                className={cn("h-full rounded-full transition-[width] duration-500", l.color)}
                style={{ width: `${total ? Math.max(4, Number((l.v * 1000n) / total) / 10) : 4}%` }}
              />
            </div>
            <p className="hidden text-sm text-ink-3 md:block">{l.note}</p>
          </div>
        ))}
      </section>

      <section className="mt-10 grid grid-cols-2 border-y rule md:grid-cols-4">
        <Stat label="Price per EDGE" value={p ? usdc(p.edge.sharePrice) : null} />
        <Stat label="Subordination" value={p ? pct(p.subordinationBps) : null} warn={!!p && p.subordinationBps < 2000} />
        <Stat label="Backs every cap" value={p ? usdc(p.capBase, { compact: true }) : null} />
        <EpochClock endsAt={p?.epochEndsAt} epoch={p?.epoch} />
      </section>

      {p?.creditEvent && <p className="mt-6 rounded-[20px] bg-berry-wash px-5 py-4 text-sm text-berry">Credit event: Floor principal was impaired. Markets are reduce-only until recapitalised.</p>}
      {p?.globalReduceOnly && !p.creditEvent && (
        <p className="mt-6 rounded-[20px] bg-berry-wash px-5 py-4 text-sm text-berry">Edge is below its minimum, so markets accept only orders that reduce exposure.</p>
      )}

      <div className="mt-14 grid gap-6 lg:grid-cols-2">
        <EdgeDesk />
        <FloorDesk />
      </div>

      <section aria-labelledby="ep-h" className="mt-16">
        <h2 id="ep-h" className="display text-3xl font-bold">
          Hourly settlements
        </h2>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="text-left text-ink-3">
              <tr className="border-b rule">
                <th className="pb-3 font-normal">Epoch</th>
                <th className="pb-3 text-right font-normal">Pool result</th>
                <th className="pb-3 text-right font-normal">Floor accrual</th>
                <th className="pb-3 text-right font-normal">Edge</th>
                <th className="pb-3 text-right font-normal">Reserve + treasury</th>
                <th className="pb-3 text-right font-normal">Skin</th>
              </tr>
            </thead>
            <tbody>
              {(ep.data?.data ?? []).map((e) => (
                <tr key={e.n} className="border-b rule">
                  <td className="num py-3">{e.n}</td>
                  <td className={cn("num py-3 text-right", BigInt(e.g) >= 0n ? "text-pos" : "text-neg")}>{usdc(e.g, { sign: true })}</td>
                  <td className="num py-3 text-right">{usdc(e.floorAccrual)}</td>
                  <td className={cn("num py-3 text-right", BigInt(e.dEdge) < 0n && "text-neg")}>{usdc(e.dEdge, { sign: true })}</td>
                  <td className="num py-3 text-right">{usdc((BigInt(e.dReserve) + BigInt(e.dTreasury)).toString())}</td>
                  <td className="num py-3 text-right">{usdc(e.skinAbsorbed)}</td>
                </tr>
              ))}
              {ep.data && ep.data.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-3">
                    The first settlement lands at the top of the hour.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | null; warn?: boolean }) {
  return (
    <div className="border-r rule py-6 pl-4 first:pl-0 last:border-r-0 md:pl-8 [&:nth-child(2)]:border-r-0 md:[&:nth-child(2)]:border-r">
      <p className="text-sm text-ink-3">{label}</p>
      {value === null ? <div className="skeleton mt-2 h-8 w-24 rounded-full" /> : <p className={cn("num display mt-1 text-3xl font-medium", warn && "text-berry")}>{value}</p>}
    </div>
  );
}

function EpochClock({ endsAt, epoch }: { endsAt?: string; epoch?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = endsAt ? Math.max(0, Date.parse(endsAt) - now) : null;
  const mm = left === null ? "—" : `${String(Math.floor(left / 60000)).padStart(2, "0")}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
  return <Stat label={epoch ? `Epoch ${epoch} settles in` : "Next settlement"} value={left === null ? null : left === 0 ? "now" : mm} />;
}

function useWalletDecks() {
  const { address } = useAccount();
  return useQuery({ queryKey: qk.wallet(address ?? "0x"), queryFn: () => api.wallet(address!), enabled: !!address, refetchInterval: 8_000 });
}

/** Approves exactly what's needed, then calls the pool. */
function usePoolTx() {
  const a = useAddresses();
  const tx = useContractTx();
  const { address } = useAccount();
  const qc = useQueryClient();
  const run = async (fn: string, args: readonly unknown[], spend?: { token: `0x${string}`; amount: bigint }) => {
    if (!a || !address) return;
    try {
      if (spend && spend.amount > 0n) await tx.send({ address: spend.token, abi: testUSDCAbi, functionName: "approve", args: [a.pool, spend.amount] });
      await tx.send({ address: a.pool, abi: blokePoolAbi, functionName: fn, args });
    } catch {
      return; // tx.error carries the explanation
    }
    qc.invalidateQueries({ queryKey: qk.pool });
    qc.invalidateQueries({ queryKey: qk.wallet(address) });
  };
  return { run, tx, ready: !!a && !!address, a };
}

function EdgeDesk() {
  const w = useWalletDecks();
  const pq = useQuery({ queryKey: qk.pool, queryFn: () => api.pool() });
  const { run, tx, ready, a } = usePoolTx();
  const [amount, setAmount] = useState("1000");
  const [mode, setMode] = useState<"deposit" | "redeem">("deposit");
  const d = w.data?.data.decks;
  const parsed = parseUsdc(amount);
  const value = parsed === null ? null : mode === "redeem" ? parsed * EDGE_EXTRA : parsed;
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  const edgeToken = pq.data?.data.edge.token;
  return (
    <section aria-labelledby="edge-h" className="tile p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="edge-h" className="display text-2xl font-bold">
            Edge
          </h2>
          <p className="mt-1 text-sm text-ink-2">Earns the pool&apos;s result after Floor. Takes losses first.</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-ink-3">Yours</p>
          <p className="num text-xl">{d ? usdc(d.edgeValue) : "—"}</p>
        </div>
      </div>
      <div role="radiogroup" aria-label="Edge action" className="mt-6 inline-flex rounded-full bg-canvas p-1">
        {(["deposit", "redeem"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn("h-10 rounded-full px-5 text-sm capitalize", mode === m ? "bg-ink text-canvas" : "text-ink-2")}>
            {m}
          </button>
        ))}
      </div>
      <label htmlFor="edge-amt" className="mt-5 block text-sm text-ink-2">
        {mode === "deposit" ? "tUSDC to deposit" : "EDGE to redeem"}
      </label>
      <input id="edge-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="field num mt-2 text-xl" />
      <button
        type="button"
        disabled={!ready || !a || value === null || value === 0n || busy || (mode === "redeem" && !edgeToken)}
        onClick={() =>
          mode === "deposit"
            ? run("requestDeposit", [value!], { token: a!.tusdc, amount: value! })
            : run("requestRedeem", [value!], { token: edgeToken!, amount: value! })
        }
        className="btn btn-accent mt-4 w-full"
      >
        {busy ? "Confirm in wallet…" : mode === "deposit" ? "Queue deposit" : "Queue redemption"}
      </button>
      <p className="mt-3 text-sm text-ink-3">Executes at the next hourly settlement, at that hour&apos;s price.</p>
      {tx.error && <p className="mt-2 text-sm text-neg">{tx.error}</p>}
      {d && d.pendingEdge.length > 0 && (
        <ul className="mt-6 divide-y divide-[var(--color-line)] border-t rule text-sm">
          {d.pendingEdge.map((r) => (
            <li key={r.epoch} className="flex items-center justify-between py-3">
              <span className="text-ink-2">
                Epoch <span className="num">{r.epoch}</span> · {BigInt(r.deposit) > 0n ? `deposit ${usdc(r.deposit)}` : `redeem ${usdc((BigInt(r.redeemShares) / EDGE_EXTRA).toString())} EDGE`}
              </span>
              {r.processed ? (
                <button type="button" disabled={busy} onClick={() => run(BigInt(r.deposit) > 0n ? "claimDeposit" : "claimRedeem", [BigInt(r.epoch)])} className="btn btn-quiet h-9 px-4 text-sm">
                  Claim
                </button>
              ) : (
                <span className="text-ink-3">Queued</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FloorDesk() {
  const pq = useQuery({ queryKey: qk.pool, queryFn: () => api.pool() });
  const w = useWalletDecks();
  const { run, tx, ready, a } = usePoolTx();
  const [amount, setAmount] = useState("1000");
  const p = pq.data?.data;
  const open = p?.floor.open;
  const d = w.data?.data.decks;
  const value = parseUsdc(amount);
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  const canSubscribe = !!open && Date.parse(open.start) > Date.now() && !p?.floor.paused;
  return (
    <section aria-labelledby="floor-h" className="tile p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="floor-h" className="display text-2xl font-bold">
            Floor
          </h2>
          <p className="mt-1 text-sm text-ink-2">A fixed rate for a fixed term. Paid before Edge, impaired last.</p>
        </div>
        {p?.floor.active && (
          <div className="text-right">
            <p className="text-sm text-ink-3">Active</p>
            <p className="num text-xl">{pct(p.floor.active.rateBps)} APR</p>
          </div>
        )}
      </div>
      {open ? (
        <>
          <p className="mt-6 text-sm text-ink-2">
            FLOOR-{open.id + 1} · <span className="num">{pct(open.rateBps)}</span> fixed · {new Date(open.start).toLocaleDateString()} → {new Date(open.end).toLocaleDateString()}
          </p>
          <label htmlFor="floor-amt" className="mt-5 block text-sm text-ink-2">
            tUSDC to subscribe
          </label>
          <input id="floor-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="field num mt-2 text-xl" />
          <button
            type="button"
            disabled={!ready || !a || !canSubscribe || value === null || value === 0n || busy}
            onClick={() => run("subscribe", [BigInt(open.id), value!], { token: a!.tusdc, amount: value! })}
            className="btn btn-accent mt-4 w-full"
          >
            {busy ? "Confirm in wallet…" : canSubscribe ? "Subscribe" : p?.floor.paused ? "Paused while Edge is below 20%" : "Subscriptions closed"}
          </button>
        </>
      ) : (
        <p className="mt-6 rounded-[20px] bg-canvas px-5 py-6 text-sm text-ink-2">No series is open for subscription right now.</p>
      )}
      {tx.error && <p className="mt-2 text-sm text-neg">{tx.error}</p>}
      {d && (d.subscriptions.length > 0 || d.floor.length > 0) && (
        <ul className="mt-6 divide-y divide-[var(--color-line)] border-t rule text-sm">
          {d.subscriptions.map((s) => (
            <li key={`s${s.seriesId}`} className="flex items-center justify-between py-3">
              <span className="text-ink-2">
                FLOOR-{s.seriesId + 1} · subscribed <span className="num">{usdc(s.amount)}</span>
              </span>
              {s.claimable ? (
                <button type="button" disabled={busy} onClick={() => run("claimSubscription", [BigInt(s.seriesId)])} className="btn btn-quiet h-9 px-4 text-sm">
                  Claim
                </button>
              ) : (
                <span className="text-ink-3">Before start</span>
              )}
            </li>
          ))}
          {d.floor.map((f) => (
            <li key={`f${f.seriesId}`} className="flex items-center justify-between py-3">
              <span className="text-ink-2">
                FLOOR-{f.seriesId + 1} · <span className="num">{usdc(f.shares)}</span>
              </span>
              {f.state === "matured" ? (
                <button type="button" disabled={busy} onClick={() => run("redeemFloor", [BigInt(f.seriesId), BigInt(f.shares)])} className="btn btn-quiet h-9 px-4 text-sm">
                  Redeem
                </button>
              ) : (
                <span className="text-ink-3">Accruing</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
