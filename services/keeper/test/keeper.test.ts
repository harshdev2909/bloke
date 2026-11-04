import { describe, expect, it } from "vitest";
import { type DecodedLog, EngineState } from "@bloke/chain-state";
import { Keeper, type KeeperReads, type LotHealth } from "../src/keeper.js";

let n = 0;
const log = (eventName: string, args: Record<string, unknown>): DecodedLog => ({
  eventName,
  args,
  address: "0x0000000000000000000000000000000000000001",
  blockNumber: BigInt(++n),
  logIndex: 0,
  transactionHash: "0x00",
});
const alice = "0x00000000000000000000000000000000000000a1";
const WAD = 10n ** 18n;

function setup(health: LotHealth[] = [], seq = 10n) {
  const s = new EngineState();
  s.apply(log("MarketCreated", { marketId: 3, blokeId: 1, leg: 0, tier: 1 }));
  s.apply(log("MarketStatusChanged", { marketId: 3, status: 2, settleIndex: 0 }));
  const reads: KeeperReads = {
    lastSeq: async () => seq,
    lotHealth: async () => health,
    frozenAt: async () => 1000n,
    maxProfitBps: async () => 20_000n,
    freezeMaxSec: async () => 72n * 3600n,
    epochEndsAt: async () => 10n ** 12n,
  };
  return { s, keeper: new Keeper(s, reads) };
}
const req = (id: bigint, deadline: bigint, seqAt = 5n, kind = 1, lotId = 0n) =>
  log("OrderRequested", { orderId: id, owner: alice, marketId: 3, side: 1, collateral: 1000_000000n, kind, seqAtRequest: seqAt, deadline, lotId });

describe("Keeper.plan", () => {
  it("expires orders past their deadline", async () => {
    const { s, keeper } = setup();
    s.apply(req(1n, 100n));
    const acts = await keeper.plan(101n);
    expect(acts).toContainEqual({ fn: "expire", ids: [1n] });
  });

  it("falls back to settling orders the pusher missed, only after a newer push", async () => {
    const { s, keeper } = setup([], 10n);
    s.apply(req(1n, 1000n, 5n));
    s.apply(req(2n, 1000n, 10n)); // no push since its request
    expect((await keeper.plan(100n)).find((a) => a.fn === "settle")).toBeUndefined(); // first sighting
    expect(await keeper.plan(103n)).toContainEqual({ fn: "settle", ids: [1n] });
  });

  it("exhausts lots at equity ≤ 0 and caps lots at +200%", async () => {
    const health: LotHealth[] = [
      { lotId: 7n, equity: -1n, pricePnl: -1001n * WAD, fundingPnl: 0n, exhausted: true },
      { lotId: 8n, equity: 3000n * WAD, pricePnl: 2000n * WAD, fundingPnl: 0n, exhausted: false },
      { lotId: 9n, equity: 1500n * WAD, pricePnl: 500n * WAD, fundingPnl: 0n, exhausted: false },
    ];
    const { s, keeper } = setup(health);
    for (const [orderId, lotId] of [[1n, 7n], [2n, 8n], [3n, 9n]] as const) {
      s.apply(req(orderId, 1000n));
      s.apply(log("OrderFilled", { orderId, lotId }));
    }
    const acts = await keeper.plan(100n);
    expect(acts).toContainEqual({ fn: "exhaust", ids: [7n] });
    expect(acts).toContainEqual({ fn: "takeProfitCap", ids: [8n] });
  });

  it("pokes live markets every 5 minutes, not every sweep", async () => {
    const { keeper } = setup();
    expect(await keeper.plan(1000n)).toContainEqual({ fn: "poke", marketIds: [3] });
    expect((await keeper.plan(1100n)).find((a) => a.fn === "poke")).toBeUndefined();
    expect(await keeper.plan(1300n)).toContainEqual({ fn: "poke", marketIds: [3] });
  });

  it("cranks the pool once the epoch has ended", async () => {
    const s = new EngineState();
    const reads: KeeperReads = {
      lastSeq: async () => 0n,
      lotHealth: async () => [],
      frozenAt: async () => 0n,
      maxProfitBps: async () => 20_000n,
      freezeMaxSec: async () => 1n,
      epochEndsAt: async () => 3600n,
    };
    const k = new Keeper(s, reads);
    expect((await k.plan(3599n)).find((a) => a.fn === "crankEpoch")).toBeUndefined();
    expect(await k.plan(3600n)).toContainEqual({ fn: "crankEpoch" });
  });

  it("settles delisted lots and expires old freezes", async () => {
    const { s, keeper } = setup();
    s.apply(req(1n, 1000n));
    s.apply(log("OrderFilled", { orderId: 1n, lotId: 7n }));
    s.apply(log("MarketStatusChanged", { marketId: 3, status: 5, settleIndex: 1_000_000 }));
    expect(await keeper.plan(100n)).toContainEqual({ fn: "settleDelisted", ids: [7n] });

    s.apply(log("MarketCreated", { marketId: 4, blokeId: 1, leg: 1, tier: 1 }));
    s.apply(log("MarketStatusChanged", { marketId: 4, status: 4, settleIndex: 1 }));
    expect((await keeper.plan(1000n + 72n * 3600n - 1n)).find((a) => a.fn === "expireFreeze")).toBeUndefined();
    expect(await keeper.plan(1000n + 72n * 3600n)).toContainEqual({ fn: "expireFreeze", marketId: 4 });
  });
});
