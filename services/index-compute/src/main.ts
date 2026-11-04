import pg from "pg";
import { Redis } from "ioredis";
import { createPublicClient } from "viem";
import { DEFAULT_PARAMS, type IndexTick, type SourceId, SyntheticSource, validateParams } from "@bloke/index-core";
import { CHAINS, POLLING_INTERVAL_MS, humanIndexOracleAbi, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { type BlokeInput, type BlokeMode, computeAll, documentVersion, modeFor, paramsDocument } from "./engine.js";
import { GitHubCollector } from "./collectors/github.js";
import { HackerNewsCollector } from "./collectors/hn.js";
import { OnchainCollector } from "./collectors/onchain.js";
import { TrendsCollector, XCountsCollector } from "./collectors/keyed.js";
import type { Collector, SourceAccount } from "./collectors/types.js";
import * as store from "./store.js";

/**
 * index-compute (PRD §13.2, phase P3): polls each Bloke's registered source accounts, stores the
 * counted events, computes the index with @bloke/index-core and publishes one tick per Bloke for
 * the oracle-pusher (Redis hash `index:ticks`). Blokes without a source on both legs follow the
 * synthetic walk, and the published params document says which mode each Bloke is in (A16).
 *
 * Env: DATABASE_URL, REDIS_URL, ADDRESSES, RPC_URL(S); optional GITHUB_TOKEN, X_BEARER_TOKEN,
 * SERPAPI_KEY; COMPUTE_MS (10000), COLLECT_MS (20000), SYNTH_VOL (0.01).
 */
const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const DAY_MS = 86_400_000;

async function main() {
  const params = DEFAULT_PARAMS;
  validateParams(params);
  const a = loadAddresses(env("ADDRESSES"));
  const chain = CHAINS[a.chainId]!;
  const client = createPublicClient({ chain, transport: rpcTransport(process.env.RPC_URLS ?? env("RPC_URL")), pollingInterval: POLLING_INTERVAL_MS });
  const db = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 4, idleTimeoutMillis: 300_000, keepAlive: true });
  // Neon resets idle connections; drop the dead client instead of crashing.
  db.on("error", (err) => log({ msg: "pg_idle_client_error", err: err.message }));
  const redis = new Redis(env("REDIS_URL"));

  const collectors: Collector[] = [new GitHubCollector(), new HackerNewsCollector(), new OnchainCollector(client as never)];
  if (process.env.X_BEARER_TOKEN) collectors.push(new XCountsCollector(process.env.X_BEARER_TOKEN));
  if (process.env.SERPAPI_KEY) collectors.push(new TrendsCollector(process.env.SERPAPI_KEY));
  const byKind = new Map<SourceId, Collector>();
  for (const c of collectors) for (const k of c.kinds) byKind.set(k, c);
  log({ msg: "index-compute started", collectors: [...byKind.keys()] });

  // ------------------------------------------------------------------ collection
  const lastPoll = new Map<string, number>();
  const collect = async () => {
    const [accounts, states] = await Promise.all([store.sourceAccounts(db), store.collectorStates(db)]);
    for (const acc of accounts) {
      const c = byKind.get(acc.kind);
      if (!c) continue;
      const key = store.accountKey(acc);
      const now = Date.now();
      const prev = lastPoll.get(key) ?? states.get(key)?.okAtMs ?? 0;
      if (now - prev < c.intervalMs) continue;
      lastPoll.set(key, now);
      try {
        const r = await c.poll(acc, structuredClone(states.get(key)?.state ?? {}), now);
        const n = await store.saveEvents(db, acc, r.events, r.mode);
        await store.markOk(db, acc, r.state);
        if (n) log({ msg: "collected", blokeId: acc.blokeId, source: acc.kind, events: n });
      } catch (err) {
        await store.markError(db, acc, String(err)).catch(() => {});
        log({ msg: "collect_failed", blokeId: acc.blokeId, source: acc.kind, error: String(err).slice(0, 200) });
      }
    }
  };

  // ------------------------------------------------------------------ compute + publish
  const synthetic = new Map<number, SyntheticSource>();
  const lastZ = new Map<number, Partial<Record<SourceId, number>>>();
  let lastRollup = 0;
  let lastTickRow = 0;
  const compute = async () => {
    const now = Date.now();
    const [blokes, accounts, states, pts] = await Promise.all([
      store.activeBlokes(db),
      store.sourceAccounts(db),
      store.collectorStates(db),
      store.points(db, now - (params.baselineDays + 2) * DAY_MS),
    ]);
    const inputs: BlokeInput[] = blokes.map((b) => ({ blokeId: b.id, sources: new Map() }));
    const byId = new Map(inputs.map((i) => [i.blokeId, i]));
    for (const acc of accounts) {
      const c = byKind.get(acc.kind);
      const input = byId.get(acc.blokeId);
      if (!c || !input) continue;
      const okAtMs = states.get(store.accountKey(acc))?.okAtMs ?? null;
      const cur = input.sources.get(acc.kind);
      // Several accounts of one kind (two repos' owners, two addresses) pool into one source.
      input.sources.set(acc.kind, {
        verified: (cur?.verified ?? false) || acc.verified,
        health: { okAtMs: cur ? Math.max(cur.health.okAtMs ?? 0, okAtMs ?? 0) || null : okAtMs, staleMs: Math.max(5 * 60_000, 3 * c.intervalMs) },
        points: cur?.points ?? pts.get(`${acc.blokeId}:${acc.kind}`) ?? [],
      });
    }

    const modes = new Map<number, BlokeMode>();
    for (const i of inputs) modes.set(i.blokeId, modeFor(params, new Set(i.sources.keys())).mode);
    const results = computeAll(inputs, params, now, lastZ);
    const doc = paramsDocument(params, modes);
    const version = documentVersion(doc);
    await store.saveParams(db, version, doc);

    const ticks: (IndexTick & { tsMs: number; mode: string; z?: Record<string, number>; degraded?: string[] })[] = [];
    for (const b of blokes) {
      const r = results.get(b.id);
      if (r) {
        lastZ.set(b.id, r.z);
        ticks.push({ blokeId: b.id, ...r.scaled, stopped: r.stopped, tsMs: now, mode: "signals", z: r.z as Record<string, number>, degraded: r.degraded });
        continue;
      }
      let s = synthetic.get(b.id);
      if (!s) {
        s = new SyntheticSource([b.id], b.id, Number(env("SYNTH_VOL", "0.01")));
        // Continue from the value on chain so switching to index-compute doesn't jump the index.
        const l = await client.readContract({ address: a.oracle, abi: humanIndexOracleAbi, functionName: "latest", args: [b.id] }).catch(() => null);
        if (l) s.seed(b.id, l.h, l.w);
        synthetic.set(b.id, s);
      }
      ticks.push({ ...s.latest(now)[0]!, tsMs: now, mode: "synthetic" });
    }

    const payload: Record<string, string> = {};
    for (const t of ticks) payload[String(t.blokeId)] = JSON.stringify({ ...t, paramsVersion: version });
    const pipe = redis.multi().del("index:ticks");
    if (ticks.length) pipe.hset("index:ticks", payload);
    await pipe.set("index:params_version", version).exec();

    if (now - lastTickRow >= 60_000) {
      lastTickRow = now;
      await store.saveTicks(
        db,
        now,
        version,
        ticks.map((t) => ({ blokeId: t.blokeId, b: t.b, h: t.h, w: t.w, z: t.z ?? {}, degraded: t.degraded ?? [], stopped: t.stopped })),
      );
    }
    if (now - lastRollup >= 10 * 60_000) {
      lastRollup = now;
      await store.rollupHourly(db, now - 2 * 3_600_000);
    }
    log({ msg: "computed", signals: results.size, synthetic: ticks.length - results.size, version: version.slice(0, 10) });
  };

  const loop = async (name: string, ms: number, fn: () => Promise<void>) => {
    for (;;) {
      try {
        await fn();
      } catch (err) {
        log({ msg: `${name}_failed`, error: String(err).slice(0, 300) });
      }
      await new Promise((r) => setTimeout(r, ms));
    }
  };
  await Promise.all([loop("collect", Number(env("COLLECT_MS", "20000")), collect), loop("compute", Number(env("COMPUTE_MS", "10000")), compute)]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
