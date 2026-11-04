"use client";

import { ExternalLink } from "lucide-react";
import { useStatus } from "@/lib/api";
import { cn } from "@/lib/cn";

const EXPLORER = "https://testnet.monadvision.com/address/";

export default function StatusPage() {
  const s = useStatus();
  const d = s.data?.data;
  return (
    <div className="mt-10">
      <h1 className="display text-4xl font-extrabold">Status</h1>
      <p className="mt-2 text-ink-2">Live health of the oracle, indexer and contracts. Refreshes every 10 seconds.</p>
      {s.isError && <p className="tile mt-6 p-5 text-neg">The API isn&apos;t reachable right now.</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Health label="Oracle" ok={!!d && !d.oracle.paused && (d.oracle.lastPushAgeMs ?? 1e9) < 60_000} detail={d ? `Seq ${d.oracle.lastSeq} · last push ${Math.round((d.oracle.lastPushAgeMs ?? 0) / 1000)}s ago` : null} />
        <Health label="Indexer" ok={!!d && (d.indexer.lagBlocks ?? 1e9) < 50} detail={d ? `${d.indexer.lagBlocks ?? "—"} blocks behind head` : null} />
        <Health label="Environment" ok={!!d} detail={d ? `${d.staging ? "Staging" : "Event"} · chain ${d.chainId}` : null} />
      </div>
      <section aria-labelledby="per-h" className="tile mt-6 p-5">
        <h2 id="per-h" className="display mb-3 text-lg font-bold">
          Index freshness by Bloke
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {d?.blokes.map((b) => (
            <li key={b.id} className="flex items-center justify-between rounded-[18px] bg-canvas px-4 py-3 text-sm">
              <span className="font-medium">${b.ticker}</span>
              <span className={cn("num text-xs", b.fresh ? "text-pos" : "text-neg")}>{b.pushAgeMs === null ? "never pushed" : `${Math.round(b.pushAgeMs / 1000)}s`}</span>
            </li>
          )) ?? <li className="skeleton h-12 rounded-[18px]" />}
        </ul>
      </section>
      <section aria-labelledby="addr-h" className="tile mt-6 p-5">
        <h2 id="addr-h" className="display mb-3 text-lg font-bold">
          Contracts
        </h2>
        <ul className="grid gap-2 md:grid-cols-2">
          {d &&
            Object.entries(d.addresses).map(([k, v]) => (
              <li key={k}>
                <a href={EXPLORER + v} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-[18px] bg-canvas px-4 py-3 text-sm hover:bg-sand-2">
                  <span className="capitalize">{k.replace(/([A-Z])/g, " $1")}</span>
                  <span className="num truncate text-xs text-ink-2" title={v}>
                    {v}
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-ink-3" aria-label="Open in explorer" />
                </a>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function Health({ label, ok, detail }: { label: string; ok: boolean; detail: string | null }) {
  return (
    <div className="tile flex items-center gap-4 p-5">
      <span className={cn("grid size-11 place-items-center rounded-full", ok ? "bg-pos/10" : "bg-neg/10")}>
        <span className={cn("size-3 rounded-full", ok ? "bg-pos" : "bg-neg")} aria-hidden />
      </span>
      <div>
        <p className="font-medium">
          {label} <span className="sr-only">{ok ? "healthy" : "degraded"}</span>
        </p>
        {detail === null ? <div className="skeleton mt-1 h-4 w-32 rounded-full" /> : <p className="text-sm text-ink-2">{detail}</p>}
      </div>
    </div>
  );
}
