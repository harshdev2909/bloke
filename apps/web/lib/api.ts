"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BlokeClient, BlokeStream, type BlokeSummary, type Channel, type Envelope, type StreamMessage } from "@bloke/sdk";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
export const api = new BlokeClient({ baseUrl: API_URL });

let stream: BlokeStream | undefined;
export function getStream() {
  if (typeof window === "undefined") return undefined;
  stream ??= new BlokeStream({ url: API_URL.replace(/^http/, "ws") + "/v1/stream" });
  return stream;
}

export const qk = {
  blokes: ["blokes"] as const,
  bloke: (t: string) => ["bloke", t] as const,
  index: (t: string, leg: string, range: string) => ["index", t, leg, range] as const,
  wallet: (a: string) => ["wallet", a.toLowerCase()] as const,
  pool: ["pool"] as const,
  status: ["status"] as const,
  trades: (m: number) => ["trades", m] as const,
  session: ["session"] as const,
  rep: ["rep"] as const,
  archetypes: ["archetypes"] as const,
};

export function useArchetypes() {
  return useQuery({ queryKey: qk.archetypes, queryFn: () => api.archetypes(), staleTime: 60_000 });
}

export function useStatus() {
  return useQuery({ queryKey: qk.status, queryFn: () => api.status(), refetchInterval: 10_000 });
}

/** Contract addresses come from the API (single source of truth per deployment). */
export function useAddresses() {
  const s = useStatus();
  return s.data?.data.addresses as
    | (Record<"engine" | "registry" | "tusdc" | "oracle" | "pool" | "settler" | "protocolConfig", `0x${string}`> &
        Partial<Record<"tbloke" | "desk" | "v2Factory" | "v2Router" | "lpLocker" | "vesting" | "distributor" | "launcher" | "repRoots" | "raise", `0x${string}`>>)
    | undefined;
}

/**
 * Bloke list with live index ticks folded in from the stream, so cards move between refetches
 * without hammering the API.
 */
export function useBlokes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.blokes, queryFn: () => api.blokes(), refetchInterval: 15_000 });
  useStreamChannels(
    q.data?.data.map((b) => `index:${b.ticker}` as Channel) ?? [],
    (m) => {
      if (m.event.type !== "index") return;
      const e = m.event;
      qc.setQueryData<Envelope<BlokeSummary[]>>(qk.blokes, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((b) =>
                b.id === e.blokeId && b.index ? { ...b, index: { ...b.index, b: e.b, h: e.h, w: e.w, lagFlags: e.lagFlags, tsMs: e.tsMs, fresh: true } } : b,
              ),
            }
          : old,
      );
    },
  );
  return q;
}

/** Subscribes to stream channels for the component's lifetime. */
export function useStreamChannels(channels: Channel[], onMessage: (m: StreamMessage) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const key = channels.join("|");
  useEffect(() => {
    const s = getStream();
    if (!s || !channels.length) return;
    s.subscribe(...channels);
    const off = s.on((m) => {
      if (channels.includes(m.channel)) handler.current(m);
    });
    return () => {
      off();
      s.unsubscribe(...channels);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Recent `feed` events (fills and closes across the exchange) for the live rail. */
export function useFeed(limit = 12) {
  const [items, setItems] = useState<StreamMessage[]>([]);
  useStreamChannels(["feed"], (m) => setItems((xs) => [m, ...xs].slice(0, limit)));
  return items;
}

/** Remembers the previous value to flash numbers in the direction of change. */
export function useDirection(v: number | null | undefined) {
  const prev = useRef(v);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (v != null && prev.current != null && v !== prev.current) setDir(v > prev.current ? "up" : "down");
    prev.current = v;
    const t = setTimeout(() => setDir(null), 650);
    return () => clearTimeout(t);
  }, [v]);
  return dir;
}
