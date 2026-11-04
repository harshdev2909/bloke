import { createPublicClient } from "viem";
import pg from "pg";
import { Redis } from "ioredis";
import { CHAINS, POLLING_INTERVAL_MS, STREAM_CHANNEL, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { Indexer } from "./indexer.js";
import { migrate } from "./migrate.js";

/**
 * Env: DATABASE_URL, RPC_URL / RPC_URLS, ADDRESSES, CONFIRMATION_TAG (finalized | latest; default finalized),
 * LOG_CHUNK, POLL_MS, REDIS_URL (optional; enables real-time publishing).
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

async function main() {
  const dbUrl = env("DATABASE_URL");
  const applied = await migrate(dbUrl);
  if (applied.length) console.log(JSON.stringify({ msg: "migrated", applied }));

  const a = loadAddresses(env("ADDRESSES"));
  const chain = CHAINS[a.chainId];
  const rpc = process.env.RPC_URLS ?? env("RPC_URL"); // RPC_URLS: comma-separated failover list
  const client = createPublicClient({ chain, transport: rpcTransport(rpc), pollingInterval: POLLING_INTERVAL_MS });
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4, idleTimeoutMillis: 300_000, keepAlive: true });
  // Neon resets idle connections; drop the dead client instead of crashing (the next query reconnects).
  pool.on("error", (err) => console.warn(JSON.stringify({ msg: "pg_idle_client_error", err: err.message })));
  const tag = env("CONFIRMATION_TAG", "finalized") as "finalized" | "latest";
  // Committed events fan out through Redis to every API instance (PRD §13.4 WebSocket channels).
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : undefined;
  const publish = redis
    ? async (events: unknown[]) => {
        const p = redis.pipeline();
        for (const e of events) p.publish(STREAM_CHANNEL, JSON.stringify(e));
        await p.exec();
      }
    : undefined;
  const indexer = new Indexer(pool, client, a, { chunk: BigInt(env("LOG_CHUNK", "100")), tag }, publish);
  const pollMs = Number(env("POLL_MS", "1000"));
  const maxSteps = process.env.MAX_STEPS ? Number(process.env.MAX_STEPS) : Infinity;
  console.log(JSON.stringify({ msg: "indexer started", chainId: a.chainId, tag }));

  for (let i = 0; i < maxSteps; i++) {
    try {
      const r = await indexer.step();
      if (r.logs) console.log(JSON.stringify({ msg: "indexed", logs: r.logs, block: r.block.toString() }));
      if (!r.caughtUp) continue;
    } catch (err) {
      console.error(JSON.stringify({ msg: "index_failed", error: String(err).slice(0, 400) }));
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await pool.end();
  redis?.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
