"use client";

import { Stipple } from "@/components/stipple";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ApiError } from "@bloke/sdk";
import { api, qk } from "@/lib/api";
import { shortAddr } from "@/lib/format";

export default function RepPage() {
  const q = useQuery({ queryKey: qk.rep, queryFn: () => api.rep(1, 100) });
  const [handle, setHandle] = useState("");
  const suggest = useMutation({ mutationFn: () => api.suggest(handle) });
  const rows = q.data?.data ?? [];
  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
      <section aria-labelledby="rep-h">
        <h1 id="rep-h" className="display text-4xl font-extrabold md:text-5xl">
          Rep · Season 1
        </h1>
        <p className="mt-2 max-w-[56ch] text-ink-2">Rep rewards being early and right, never volume. Hedging two legs of the same person earns nothing extra.</p>
        <div className="tile mt-6 p-5">
          {q.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-12 rounded-[18px]" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="rounded-[20px] bg-canvas px-4 py-8 text-center text-ink-2">The leaderboard opens after the first scoring run. Close a winning trade to get on it.</p>
          ) : (
            <ol className="space-y-2">
              {rows.map((r) => (
                <li key={r.wallet} className="flex items-center gap-4 rounded-[18px] bg-canvas px-4 py-3">
                  <span className="num w-8 text-ink-2">{r.rank}</span>
                  <a href={`/u/${r.wallet}`} className="num hover:text-accent-ink">
                    {shortAddr(r.wallet)}
                  </a>
                  <span className="num ml-auto">{Math.round(r.total).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
      <aside className="h-fit space-y-6">
        <Stipple name="chrysippos" className="w-full" />
        <div className="tile p-6">
        <h2 className="display text-xl font-bold">Suggest a Bloke</h2>
        <p className="mt-1 text-sm text-ink-2">If they get listed and trade 50,000 tUSDC in their first week, the first suggester earns the Spotter bonus.</p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            suggest.mutate();
          }}
        >
          <label htmlFor="handle" className="block text-sm text-ink-2">
            GitHub or X handle
          </label>
          <input
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            autoComplete="off"
            placeholder="@builder"
            className="h-12 w-full rounded-[18px] bg-white px-4 shadow-[inset_0_0_0_1px_#E4E0DC] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_2px_#5B44E8]"
          />
          <button type="submit" disabled={handle.length < 2 || suggest.isPending} className="rounded-full h-11 bg-accent-ink px-5 text-sm font-medium text-white hover:bg-deep disabled:opacity-50">
            {suggest.isPending ? "Sending…" : "Suggest"}
          </button>
          {suggest.isSuccess && (
            <p role="status" className="text-sm text-pos">
              {suggest.data.data.first ? "You're the first to suggest them." : "Already suggested. Thanks anyway!"}
            </p>
          )}
          {suggest.error && (
            <p role="alert" className="text-sm text-neg">
              {suggest.error instanceof ApiError && suggest.error.status === 401 ? "Sign in on your profile page first." : (suggest.error as Error).message}
            </p>
          )}
        </form>
        </div>
      </aside>
    </div>
  );
}
