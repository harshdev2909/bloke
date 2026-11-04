"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RaiseCard } from "@/components/raise";
import { tokens } from "@/components/graduation";
import { Sigil } from "@/components/sigil";
import { Stipple } from "@/components/stipple";
import { StartRaise } from "@/components/start-raise";
import { HallOfFounders } from "@/components/hall";

export default function RaisePage() {
  const q = useQuery({ queryKey: ["raises"], queryFn: () => api.raises(), refetchInterval: 15_000 });
  const rows = q.data?.data ?? [];
  const open = rows.filter((r) => r.state === "open");
  const past = rows.filter((r) => r.state !== "open");
  const launched = useQuery({ queryKey: ["graduations"], queryFn: () => api.graduations(), refetchInterval: 30_000 });

  return (
    <div className="mt-10">
      <div className="grid items-end gap-10 md:grid-cols-[1fr_300px]">
        <div>
          <h1 className="display text-5xl font-bold md:text-6xl">Raise</h1>
          <p className="mt-4 max-w-[44ch] text-lg text-ink-2">Back a person before their token exists. All or nothing; backers share in the graduation allocation.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#start-h" className="btn btn-accent">
              Start your raise
            </a>
            <a href="#open-h" className="btn btn-quiet">
              Back someone
            </a>
          </div>
        </div>
        <Stipple name="athena" className="hidden md:block" sizes="300px" priority />
      </div>

      <div className="mt-12 scroll-mt-28" id="start">
        <StartRaise />
      </div>

      <section aria-labelledby="open-h" className="mt-14">
        <h2 id="open-h" className="display text-3xl font-bold">
          Open now
        </h2>
        {q.isLoading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skeleton h-44 rounded-[32px]" />
            ))}
          </div>
        ) : q.isError ? (
          <div className="mt-6 rounded-[28px] bg-sand p-10 text-center">
            <p className="text-ink-2">Raises didn&apos;t load.</p>
            <button type="button" onClick={() => q.refetch()} className="btn btn-ink mt-5">
              Try again
            </button>
          </div>
        ) : open.length === 0 ? (
          <div className="mt-6 grid items-center gap-6 rounded-[32px] bg-sand p-8 sm:grid-cols-[160px_1fr]">
            <Stipple name="constantine" className="w-40 bg-transparent p-0" sizes="160px" />
            <div>
              <p className="text-ink-2">No raise is open. A claimed person opens one from their profile.</p>
              <Link href="/me" className="btn btn-ink mt-5">
                Claim your profile
              </Link>
            </div>
          </div>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {open.map((r) => (
              <li key={r.id}>
                <RaiseCard r={r} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {(launched.data?.data.length ?? 0) > 0 && (
        <section aria-labelledby="launched-h" className="mt-16">
          <h2 id="launched-h" className="display text-3xl font-bold">
            Launched
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {launched.data!.data.map((g) => (
              <li key={g.token}>
                <Link href={`/b/${g.ticker}#tok-h`} className="tile block p-6 transition-transform duration-150 ease-out hover:-translate-y-0.5">
                  <div className="flex items-center gap-3">
                    <Sigil ticker={g.ticker} size={40} />
                    <div className="min-w-0">
                      <p className="truncate font-semibold">${g.symbol}</p>
                      <p className="truncate text-sm text-ink-3">{g.name}</p>
                    </div>
                    <span className="ml-auto rounded-full bg-accent-wash px-3 py-1 text-xs text-deep">Token live</span>
                  </div>
                  <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-ink-3">Price</p>
                      <p className="num font-medium">{tokens(g.price!.tbloke)} tBLOKE</p>
                    </div>
                    <div>
                      <p className="text-xs text-ink-3">Pool</p>
                      <p className="num font-medium">{tokens(g.reserves!.tbloke)} tBLOKE</p>
                    </div>
                  </div>
                  <p className="num mt-3 text-xs text-ink-3">LP locked to {new Date(g.lock!.unlockAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-16">
        <HallOfFounders />
      </div>

      {past.length > 0 && (
        <section aria-labelledby="past-h" className="mt-16">
          <h2 id="past-h" className="display text-3xl font-bold">
            Closed
          </h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {past.map((r) => (
              <li key={r.id}>
                <RaiseCard r={r} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
