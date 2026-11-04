import { type Account, type Chain, type PublicClient, type Transport, type WalletClient, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pg from "pg";
import { Redis } from "ioredis";
import { type Addresses, CHAINS, POLLING_INTERVAL_MS, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import type { Env } from "./env.js";

/** Everything a request handler needs. Stateless apart from caches, so instances scale horizontally. */
export interface Ctx {
  env: Env;
  a: Addresses;
  chain: Chain;
  db: pg.Pool;
  redis: Redis;
  pub: PublicClient<Transport, Chain>;
  relayer: WalletClient<Transport, Chain, Account>;
  lister: WalletClient<Transport, Chain, Account> | null;
  attester: Account & { signTypedData: NonNullable<Account["signTypedData"]> };
  cache: TtlCache;
}

export async function createCtx(env: Env): Promise<Ctx> {
  const a = loadAddresses(env.ADDRESSES);
  const chain = CHAINS[a.chainId];
  if (!chain) throw new Error(`unknown chain ${a.chainId}`);
  const transport = rpcTransport(env.RPC_URLS ?? env.RPC_URL);
  const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS }) as PublicClient<Transport, Chain>;
  const relayer = createWalletClient({
    chain,
    transport,
    account: privateKeyToAccount(env.FAUCET_RELAYER_PRIVATE_KEY as `0x${string}`),
    pollingInterval: POLLING_INTERVAL_MS,
  });
  // Keep connections warm: a fresh TLS connection to a managed Postgres (Neon) costs seconds.
  const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10, idleTimeoutMillis: 300_000, keepAlive: true });
  // Neon resets idle connections; the pool drops the dead client and reconnects on the next query.
  // Without a listener the 'error' event would crash the process.
  db.on("error", (err) => console.warn(JSON.stringify({ msg: "pg_idle_client_error", err: err.message })));
  return {
    env,
    a,
    chain,
    db,
    redis: new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 }),
    pub,
    relayer,
    lister:
      env.LISTER_PRIVATE_KEY && a.staging
        ? createWalletClient({ chain, transport, account: privateKeyToAccount(env.LISTER_PRIVATE_KEY as `0x${string}`), pollingInterval: POLLING_INTERVAL_MS })
        : null,
    attester: privateKeyToAccount(env.ATTESTER_PRIVATE_KEY as `0x${string}`) as Ctx["attester"],
    cache: new TtlCache(),
  };
}

export async function closeCtx(ctx: Ctx) {
  await ctx.db.end();
  ctx.redis.disconnect();
}

/**
 * Short-lived per-instance cache for chain reads. Many clients poll the same Bloke list; a 1 s TTL
 * turns N requests per second into one RPC round per instance (the public RPC caps eth_call at 25 rps).
 * Concurrent misses share one in-flight promise.
 */
export class TtlCache {
  private readonly m = new Map<string, { at: number; v: Promise<unknown> }>();

  get<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.v as Promise<T>;
    const v = fn();
    this.m.set(key, { at: now, v });
    v.catch(() => this.m.delete(key));
    if (this.m.size > 5_000) {
      for (const [k, e] of this.m) if (now - e.at > 60_000) this.m.delete(k);
    }
    return v;
  }
}
