/**
 * End-to-end loop against a live deployment (local Anvil or Monad testnet staging) with the oracle
 * pusher, keeper and (optionally) indexer running. Covers PRD F1–F4 plus the A8 gasless faucet:
 *
 *   fresh wallet → relayed faucet + MON drip → open with permit → fill at next push → spread →
 *   close → payout; reverts and rejects decode to the right errors; indexer rows appear.
 *
 * Env: ADDRESSES, RPC_URL, DEPLOYER_PRIVATE_KEY (admin + lister + relayer), ATTESTER_PRIVATE_KEY,
 *      DATABASE_URL (optional), DRIP_MON (default 0.5).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  keccak256,
  parseEther,
  toHex,
  BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import pg from "pg";
import { ensureLive } from "./helpers.js";
import { CHAINS, blokeRegistryAbi, gasLimitFromEstimate, rpcTransport, POLLING_INTERVAL_MS, marketEngineAbi, protocolConfigAbi, testUSDCAbi } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const a = loadAddresses(env("ADDRESSES"));
const chain = CHAINS[a.chainId]!;
const rpc = process.env.RPC_URLS ?? env("RPC_URL");
const pub = createPublicClient({ chain, transport: rpcTransport(rpc), pollingInterval: POLLING_INTERVAL_MS });
const deployer = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex);
const attester = privateKeyToAccount(env("ATTESTER_PRIVATE_KEY") as Hex);
const admin = createWalletClient({ chain, transport: rpcTransport(rpc), account: deployer, pollingInterval: POLLING_INTERVAL_MS });
const traderKey = generatePrivateKey();
const trader = privateKeyToAccount(traderKey);
const tw = createWalletClient({ chain, transport: rpcTransport(rpc), account: trader, pollingInterval: POLLING_INTERVAL_MS });
const key32 = (s: string) => toHex(s, { size: 32 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timings: Record<string, number> = {};

/** Sends a write with the Monad gas policy (estimate × 1.15) and waits for the receipt. */
async function write(wallet: typeof admin | typeof tw, call: Record<string, unknown>) {
  const est = await pub.estimateContractGas({ ...call, account: wallet.account } as never);
  const hash = await wallet.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  expect(rc.status).toBe("success");
  return rc;
}

async function revertName(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BaseError) {
      const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
    }
    throw err;
  }
  return undefined;
}

/** Polls the engine until an order leaves Pending; returns its final status and elapsed ms. */
async function waitFinal(orderId: bigint, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const o = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "order", args: [orderId] });
    if (o.status !== 1) return { status: o.status, ms: Date.now() - t0 };
    await sleep(250);
  }
  throw new Error(`order ${orderId} still pending after ${timeoutMs} ms`);
}

function orderIdsFrom(rc: { logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] | [] }[] }): bigint[] {
  const ids: bigint[] = [];
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== a.engine.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: marketEngineAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "OrderRequested") ids.push(ev.args.orderId);
    } catch {}
  }
  return ids;
}

const FOUNDER = 1;
let marketB: number;
let marketW: number;

describe("BLOKE loop", () => {
  beforeAll(async () => {
    marketB = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "marketIdOf", args: [FOUNDER, 0] });
    marketW = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "marketIdOf", args: [FOUNDER, 2] });
    await ensureLive(FOUNDER);
  });

  it("F1/A8: a fresh wallet gets MON and tUSDC without sending a transaction itself", async () => {
    const drip = parseEther(env("DRIP_MON", "0.5"));
    const h = await admin.sendTransaction({ to: trader.address, value: drip });
    await pub.waitForTransactionReceipt({ hash: h });

    const identityHash = keccak256(toHex(`github:it-${trader.address}`));
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 300);
    const sig = await attester.signTypedData({
      domain: { name: "BLOKE Test USDC", version: "1", chainId: a.chainId, verifyingContract: a.tusdc },
      types: { Faucet: [{ name: "identityHash", type: "bytes32" }, { name: "wallet", type: "address" }, { name: "expiry", type: "uint64" }] },
      primaryType: "Faucet",
      message: { identityHash, wallet: trader.address, expiry },
    });
    await write(admin, { address: a.tusdc, abi: testUSDCAbi, functionName: "faucet", args: [trader.address, identityHash, expiry, sig] });
    expect(await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] })).toBe(10_000_000_000n);

    expect(
      await revertName(() =>
        pub.simulateContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "faucet", args: [trader.address, identityHash, expiry, sig], account: deployer }),
      ),
    ).toBe("FaucetCooldown");
  });

  let lotB: bigint;

  it("F2: open long with a permit in one transaction, filled at the next push", async () => {
    const amount = 100_000_000n; // 100 tUSDC
    const nonce = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "nonces", args: [trader.address] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const permit = await trader.signTypedData({
      domain: { name: "BLOKE Test USDC", version: "1", chainId: a.chainId, verifyingContract: a.tusdc },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: trader.address, spender: a.engine, value: amount, nonce, deadline },
    });
    const r = BigInt(permit.slice(0, 66));
    const s = `0x${permit.slice(66, 130)}` as Hex;
    const v = Number(`0x${permit.slice(130, 132)}`);
    const t0 = Date.now();
    const rc = await write(tw, {
      address: a.engine,
      abi: marketEngineAbi,
      functionName: "requestOpenWithPermit",
      args: [marketB, 1, amount, 100, 0n, deadline, v, toHex(r, { size: 32 }), s],
    });
    const [orderId] = orderIdsFrom(rc as never);
    const fin = await waitFinal(orderId!);
    timings.openFillMs = Date.now() - t0;
    expect(fin.status).toBe(2); // Filled
    const m = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "market", args: [marketB] });
    lotB = (BigInt(marketB) << 32n) | BigInt(m.lotCount);
    const lot = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "lot", args: [lotB] });
    expect(lot.owner).toBe(trader.address);
    expect(lot.status).toBe(1);
  });

  it("one side per market: a short on the same market reverts OppositeSideOpen", async () => {
    await write(tw, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.engine, 2n ** 255n] });
    expect(
      await revertName(() =>
        pub.simulateContract({ address: a.engine, abi: marketEngineAbi, functionName: "requestOpen", args: [marketB, -1, 50_000_000n, 100, 0n], account: trader }),
      ),
    ).toBe("OppositeSideOpen");
    expect(
      await revertName(() =>
        pub.simulateContract({ address: a.engine, abi: marketEngineAbi, functionName: "requestOpen", args: [marketB, 1, 9_000_000n, 100, 0n], account: trader }),
      ),
    ).toBe("BelowMinLot");
  });

  it("F3: Underrated spread fills both legs", async () => {
    const t0 = Date.now();
    const rc = await write(tw, { address: a.engine, abi: marketEngineAbi, functionName: "requestSpread", args: [FOUNDER, 1, 200_000_000n, 300, 0n] });
    const ids = orderIdsFrom(rc as never);
    expect(ids).toHaveLength(2);
    const [x, y] = await Promise.all(ids.map((id) => waitFinal(id)));
    timings.spreadFillMs = Date.now() - t0;
    expect([x!.status, y!.status]).toEqual([2, 2]);
    const w = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "market", args: [marketW] });
    expect(w.openLots).toBeGreaterThan(0);
  });

  it("F4: close pays collateral ± PnL to the wallet", async () => {
    const before = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    const t0 = Date.now();
    const rc = await write(tw, { address: a.engine, abi: marketEngineAbi, functionName: "requestClose", args: [lotB, 500] });
    const [orderId] = orderIdsFrom(rc as never);
    const fin = await waitFinal(orderId!);
    timings.closeFillMs = Date.now() - t0;
    expect(fin.status).toBe(2);
    const after = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    const payout = after - before;
    expect(payout).toBeGreaterThan(90_000_000n); // 100 ± a small move
    expect(payout).toBeLessThan(110_000_000n);
    const lot = await pub.readContract({ address: a.engine, abi: marketEngineAbi, functionName: "lot", args: [lotB] });
    expect(lot.status).toBe(2); // Closed
  });

  it("indexer mirrors the trader's orders, lots and closes", async (ctx) => {
    if (!process.env.DATABASE_URL) return ctx.skip();
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const owner = Buffer.from(trader.address.slice(2), "hex");
      let orders = 0;
      for (let i = 0; i < 60; i++) {
        const r = await db.query(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'filled')::int AS filled FROM orders WHERE owner = $1`,
          [owner],
        );
        orders = r.rows[0].filled;
        if (orders >= 4) break;
        await sleep(1000);
      }
      expect(orders).toBe(4); // open, 2 spread legs, close
      const lots = await db.query(`SELECT status FROM lots WHERE owner = $1 ORDER BY id`, [owner]);
      expect(lots.rows.map((x) => x.status).sort()).toEqual(["closed", "open", "open"]);
      const closes = await db.query(`SELECT payout FROM closes c JOIN lots l ON l.id = c.lot_id WHERE l.owner = $1`, [owner]);
      expect(closes.rows).toHaveLength(1);
    } finally {
      await db.end();
    }
  });

  it("reports fill latency (target p95 ≤ 5 s)", () => {
    console.log(JSON.stringify({ trader: trader.address, ...timings }));
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(15_000);
  });
});
