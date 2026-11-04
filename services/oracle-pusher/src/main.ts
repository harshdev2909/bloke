import { createPublicClient, createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, POLLING_INTERVAL_MS, humanIndexOracleAbi, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { EngineState, LogReader } from "@bloke/chain-state";
import { AccountSigner, ViemOracleChain } from "./chain.js";
import { DEFAULT_PUSHER_CONFIG, Pusher } from "./pusher.js";
import { Redis } from "ioredis";
import { type IndexSource, SyntheticSource } from "./source.js";
import { RedisIndexSource } from "./redis-source.js";

/**
 * Env:
 *   RPC_URL               HTTP or WS RPC (dedicated RPC in staging/event; the public RPC caps eth_call at 25 rps)
 *   ADDRESSES             path to the deployments JSON
 *   RELAYER_PRIVATE_KEY   pays gas for pushes (no on-chain powers)
 *   ORACLE_SIGNER_KEY     dev/staging only; the event environment uses the KMS signer
 *   BLOKE_IDS             comma-separated ids for the synthetic source (P0/P1)
 *   TICK_MS               scheduler cadence, default 1000
 *   LOG_CHUNK             eth_getLogs block range, default 100
 *   MAX_TICKS             stop after N ticks (tests)
 *   MIN_CHANGE            push threshold, scaled ×1e4 (default 200 = 0.02 points)
 *   HEARTBEAT_MS          push at least this often (default 30000)
 *   LOOKBACK_BLOCKS       how far back to scan for pending orders on start (default 2500)
 *   SYNTH_VOL             synthetic walk volatility per √minute in z-space (default 0.01)
 *   LAG_EVERY_MS          minimum gap between catch-up pushes (default 0 = back to back)
 *   MAX_LAG_STREAK        catch-up pushes in a row before waiting for new raw values (default unlimited)
 *   SOURCE                "synthetic" (default, P0/P1) or "compute": ticks from index-compute via REDIS_URL (P3)
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function main() {
  const addresses = loadAddresses(env("ADDRESSES"));
  const chain = CHAINS[addresses.chainId];
  if (!chain) throw new Error(`unknown chain ${addresses.chainId}`);
  const rpc = process.env.RPC_URLS ?? env("RPC_URL"); // RPC_URLS: comma-separated failover list
  const transport = rpcTransport(rpc);

  const relayer = privateKeyToAccount(env("RELAYER_PRIVATE_KEY") as Hex);
  const signerAccount = privateKeyToAccount((process.env.ORACLE_SIGNER_KEY ?? env("ORACLE_SIGNER_PRIVATE_KEY")) as Hex);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
  const walletClient = createWalletClient({ chain, transport, account: relayer, pollingInterval: POLLING_INTERVAL_MS });

  // Engine view: pending orders are settled with the next push (PRD §7.1 step 2).
  const state = new EngineState();
  // Only pending orders matter here and they expire within MAX_DEADLINE (600 s ≈ 2,000 Monad blocks),
  // so start a little before that instead of replaying from the deploy block.
  const head = await publicClient.getBlockNumber();
  const lookback = BigInt(env("LOOKBACK_BLOCKS", "2500"));
  const from = head > lookback ? head - lookback : 0n;
  const start = from > BigInt(addresses.startBlock ?? 0) ? from : BigInt(addresses.startBlock ?? 0);
  const reader = new LogReader(publicClient, [addresses.engine], start, {
    chunk: BigInt(env("LOG_CHUNK", "100")),
    tag: "latest",
  });

  let source: IndexSource;
  let blokeIds: number[] | "from index-compute";
  if (env("SOURCE", "synthetic") === "compute") {
    const s = new RedisIndexSource(new Redis(env("REDIS_URL")), Number(env("STALE_TICK_MS", "90000")));
    await s.start();
    source = s;
    blokeIds = "from index-compute";
  } else {
    const ids = env("BLOKE_IDS", "1").split(",").map(Number);
    const s = new SyntheticSource(ids, Number(process.env.SEED ?? 1), Number(env("SYNTH_VOL", "0.01")));
    for (const id of ids) {
      const l = await publicClient.readContract({ address: addresses.oracle, abi: humanIndexOracleAbi, functionName: "latest", args: [id] });
      s.seed(id, l.h, l.w);
    }
    source = s;
    blokeIds = ids;
  }
  const pusher = new Pusher(
    source,
    new ViemOracleChain(publicClient, walletClient, addresses.oracle, addresses.settler),
    new AccountSigner(signerAccount, chain.id, addresses.oracle),
    {
      ...DEFAULT_PUSHER_CONFIG,
      minChangeScaled: Number(env("MIN_CHANGE", String(DEFAULT_PUSHER_CONFIG.minChangeScaled))),
      heartbeatMs: Number(env("HEARTBEAT_MS", String(DEFAULT_PUSHER_CONFIG.heartbeatMs))),
      lagEveryMs: Number(env("LAG_EVERY_MS", "0")),
      maxLagStreak: process.env.MAX_LAG_STREAK ? Number(process.env.MAX_LAG_STREAK) : Infinity,
    },
    {
      pushed: (i) => log({ msg: "pushed", ...i }),
      failed: (i) => log({ msg: "push_failed", consecutive: i.consecutive, error: String(i.error).slice(0, 300) }),
      alert: (m) => log({ msg: "ALERT", alert: m }),
    },
    () => state.pendingIds(),
  );

  const tickMs = Number(env("TICK_MS", "1000"));
  const maxTicks = process.env.MAX_TICKS ? Number(process.env.MAX_TICKS) : Infinity;
  log({ msg: "oracle-pusher started", chainId: chain.id, oracle: addresses.oracle, settler: addresses.settler, blokeIds });
  for (let i = 0; i < maxTicks; i++) {
    try {
      let caughtUp = false;
      while (!caughtUp) {
        const r = await reader.next();
        state.applyAll(r.logs);
        caughtUp = r.caughtUp;
      }
    } catch (err) {
      log({ msg: "sync_failed", error: String(err).slice(0, 300) });
    }
    await pusher.tick(Date.now());
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
