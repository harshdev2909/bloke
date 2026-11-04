import { describe, expect, it } from "vitest";
import { type DecodedLog, EngineState, decodeTicker } from "../src/index.js";

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

describe("EngineState", () => {
  it("tracks orders through fill, lot through close", () => {
    const s = new EngineState();
    s.apply(log("MarketCreated", { marketId: 3, blokeId: 1, leg: 0, tier: 1 }));
    s.apply(log("MarketStatusChanged", { marketId: 3, status: 2, settleIndex: 0 }));
    s.apply(log("OrderRequested", { orderId: 10n, owner: alice, marketId: 3, side: 1, collateral: 1000n, kind: 1, seqAtRequest: 5n, deadline: 100n, lotId: 0n }));
    expect(s.pendingIds()).toEqual([10n]);
    expect(s.expiredIds(101n)).toEqual([10n]);
    s.apply(log("OrderFilled", { orderId: 10n, lotId: 77n, fillPrice: 1n, index: 1, premiumAfter: 0n }));
    expect(s.pending.size).toBe(0);
    expect(s.openLots.get(77n)).toMatchObject({ owner: alice, marketId: 3, collateral: 1000n });
    expect(s.lotsOn(["Live"])).toHaveLength(1);

    s.apply(log("OrderRequested", { orderId: 11n, owner: alice, marketId: 3, side: 1, collateral: 0n, kind: 2, seqAtRequest: 6n, deadline: 200n, lotId: 77n }));
    s.apply(log("OrderFilled", { orderId: 11n, lotId: 77n, fillPrice: 1n, index: 1, premiumAfter: 0n }));
    s.apply(log("LotClosed", { lotId: 77n }));
    expect(s.openLots.size).toBe(0);
    expect(s.pending.size).toBe(0);
  });

  it("rejects, cancels and expiries clear pending; market status follows events", () => {
    const s = new EngineState();
    s.apply(log("MarketCreated", { marketId: 4, blokeId: 1, leg: 1, tier: 1 }));
    for (const [id, ev] of [[1n, "OrderRejected"], [2n, "OrderCancelled"], [3n, "OrderExpired"]] as const) {
      s.apply(log("OrderRequested", { orderId: id, owner: alice, marketId: 4, side: 1, collateral: 1n, kind: 1, seqAtRequest: 0n, deadline: 9n, lotId: 0n }));
      s.apply(log(ev, { orderId: id }));
    }
    expect(s.pending.size).toBe(0);
    s.apply(log("MarketStatusChanged", { marketId: 4, status: 5, settleIndex: 1 }));
    expect(s.markets.get(4)!.status).toBe("SettleOnly");
  });

  it("snapshots round-trip exactly", () => {
    const s = new EngineState();
    s.apply(log("MarketCreated", { marketId: 3, blokeId: 1, leg: 0, tier: 1 }));
    s.apply(log("OrderRequested", { orderId: 10n, owner: alice, marketId: 3, side: 1, collateral: 1000n, kind: 1, seqAtRequest: 5n, deadline: 100n, lotId: 0n }));
    s.apply(log("OrderRequested", { orderId: 11n, owner: alice, marketId: 3, side: 1, collateral: 5n, kind: 1, seqAtRequest: 5n, deadline: 100n, lotId: 0n }));
    s.apply(log("OrderFilled", { orderId: 11n, lotId: 2n ** 40n, fillPrice: 1n, index: 1, premiumAfter: 0n }));
    s.apply(log("IndexPushed", { seq: 9n }));
    const { state, cursor } = EngineState.fromJSON(JSON.parse(JSON.stringify(s.toJSON(1234n))));
    expect(cursor).toBe(1234n);
    expect(state.lastSeq).toBe(9n);
    expect(state.pending.get(10n)).toEqual(s.pending.get(10n));
    expect(state.openLots.get(2n ** 40n)).toEqual(s.openLots.get(2n ** 40n));
    expect(state.markets.get(3)).toEqual(s.markets.get(3));
  });

  it("decodes bytes16 tickers", () => {
    expect(decodeTicker("0x464f554e444552000000000000000000")).toBe("FOUNDER");
  });
});
