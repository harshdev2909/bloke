import { createPublicClient, createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, POLLING_INTERVAL_MS, rpcTransport, gasLimitFromEstimate, blokePoolAbi, graduationLauncherAbi, humanIndexOracleAbi, marketEngineAbi, protocolConfigAbi } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EngineState, LogReader } from "@bloke/chain-state";
import { DEFAULT_KEEPER_CONFIG, Keeper, type KeeperAction, type KeeperReads } from "./keeper.js";

/**
 * Env: RPC_URL, ADDRESSES, KEEPER_PRIVATE_KEY, SWEEP_MS (default 5000), LOG_CHUNK (100), MAX_SWEEPS,
 * MIN_BALANCE_MON (alert threshold, default 20), SNAPSHOT_PATH (default .state/keeper-<chain>-<engine>.json).
 * The keeper holds no roles: a stolen key can only waste gas (PRD §13.2).
 */
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}
const log = (o: Record<string, unknown>) =>
  console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const toKey = (s: string) => {
  const b = Buffer.alloc(32);
  b.write(s, "ascii");
  return `0x${b.toString("hex")}` as Hex;
};

async function main() {
  const a = loadAddresses(env("ADDRESSES"));
  const chain = CHAINS[a.chainId];
  if (!chain) throw new Error(`unknown chain ${a.chainId}`);
  const rpc = process.env.RPC_URLS ?? env("RPC_URL"); // RPC_URLS: comma-separated failover list
  const transport = rpcTransport(rpc);
  const account = privateKeyToAccount(env("KEEPER_PRIVATE_KEY") as Hex);
  const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
  const wallet = createWalletClient({ chain, transport, account, pollingInterval: POLLING_INTERVAL_MS });

  // Resume from a snapshot when one exists for this exact deployment; otherwise replay from deploy.
  // One snapshot per deployment: a redeploy (new engine address) never loads a stale state.
  const snapPath = env("SNAPSHOT_PATH", `${env("STATE_DIR", ".state")}/keeper-${a.chainId}-${a.engine.toLowerCase()}.json`);
  let state = new EngineState();
  let cursor = BigInt(a.startBlock ?? 0);
  if (existsSync(snapPath)) {
    try {
      const restored = EngineState.fromJSON(JSON.parse(readFileSync(snapPath, "utf8")));
      state = restored.state;
      cursor = restored.cursor;
      log({ msg: "snapshot_loaded", path: snapPath, cursor, pending: state.pending.size, openLots: state.openLots.size });
    } catch (err) {
      log({ msg: "snapshot_ignored", error: String(err).slice(0, 200) });
    }
  }
  const reader = new LogReader(pub, [a.engine], cursor, { chunk: BigInt(env("LOG_CHUNK", "100")), tag: "latest" });
  const saveSnapshot = () => {
    mkdirSync(dirname(snapPath), { recursive: true });
    writeFileSync(`${snapPath}.tmp`, JSON.stringify(state.toJSON(reader.cursor)));
    renameSync(`${snapPath}.tmp`, snapPath); // atomic replace
  };

  const reads: KeeperReads = {
    lastSeq: () => pub.readContract({ address: a.oracle, abi: humanIndexOracleAbi, functionName: "lastSeq" }),
    lotHealth: async (ids) => {
      const calls = ids.map((id) => ({ address: a.engine, abi: marketEngineAbi, functionName: "lotView", args: [id] }) as const);
      // Multicall3 where the chain has it (Monad), plain parallel reads otherwise (Anvil).
      const res = chain.contracts?.multicall3
        ? await pub.multicall({ contracts: calls, allowFailure: true })
        : await Promise.all(
            calls.map((c) =>
              pub.readContract(c).then(
                (result) => ({ status: "success" as const, result }),
                () => ({ status: "failure" as const, result: undefined }),
              ),
            ),
          );
      return res.flatMap((r, i) =>
        r.status === "success" && r.result
          ? [{ lotId: ids[i]!, equity: r.result[0], pricePnl: r.result[1], fundingPnl: r.result[2], exhausted: r.result[3] }]
          : [],
      );
    },
    frozenAt: async (id) =>
      (await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "market", args: [id] })).frozenAt,
    maxProfitBps: () =>
      pub.readContract({ address: a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [toKey("MAX_PROFIT_BPS")] }),
    epochEndsAt: async () => {
      const n = await pub.readContract({ address: a.pool, abi: blokePoolAbi, functionName: "nav" });
      return BigInt(n[8]);
    },
    freezeMaxSec: () =>
      pub.readContract({ address: a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [toKey("FREEZE_MAX_SEC")] }),
  };
  const keeper = new Keeper(state, reads, { ...DEFAULT_KEEPER_CONFIG, snapshotOiEverySec: a.launcher ? DEFAULT_KEEPER_CONFIG.snapshotOiEverySec : 0n });

  const send = async (act: KeeperAction) => {
    const call =
      act.fn === "crankEpoch"
        ? ({ address: a.pool, abi: blokePoolAbi, functionName: "crankEpoch", args: [] } as const)
        : act.fn === "snapshotOi"
          ? ({ address: a.launcher!, abi: graduationLauncherAbi, functionName: "snapshotOi", args: [act.blokeIds] } as const)
          : ({
            address: a.engine,
            abi: marketEngineAbi,
            functionName: act.fn,
            args: act.fn === "poke" ? [act.marketIds] : act.fn === "expireFreeze" ? [act.marketId] : [act.ids],
          } as const);
    try {
      const est = await pub.estimateContractGas({ ...call, account } as never);
      const hash = await wallet.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 15_000 });
      log({ msg: "keeper_tx", fn: act.fn, n: "ids" in act ? act.ids.length : "blokeIds" in act ? act.blokeIds.length : 1, status: rc.status, hash });
    } catch (err) {
      log({ msg: "keeper_tx_failed", fn: act.fn, error: String(err).slice(0, 300) });
    }
  };

  const sweepMs = Number(env("SWEEP_MS", "5000"));
  const maxSweeps = process.env.MAX_SWEEPS ? Number(process.env.MAX_SWEEPS) : Infinity;
  const minBalance = BigInt(Math.round(Number(env("MIN_BALANCE_MON", "20")) * 1e6)) * 10n ** 12n;
  log({ msg: "keeper started", chainId: chain.id, engine: a.engine, keeper: account.address });
  for (let i = 0; i < maxSweeps; i++) {
    try {
      let caughtUp = false;
      while (!caughtUp) {
        const r = await reader.next();
        state.applyAll(r.logs);
        caughtUp = r.caughtUp;
      }
      saveSnapshot();
      const now = (await pub.getBlock()).timestamp;
      for (const act of await keeper.plan(now)) await send(act);
      if (i % 12 === 0) {
        const bal = await pub.getBalance({ address: account.address });
        if (bal < minBalance) log({ msg: "ALERT", alert: `keeper balance low: ${bal}` });
        log({ msg: "keeper_status", pending: state.pending.size, openLots: state.openLots.size, markets: state.markets.size });
      }
    } catch (err) {
      log({ msg: "sweep_failed", error: String(err).slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, sweepMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
