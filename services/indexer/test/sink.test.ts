import { describe, expect, it } from "vitest";
import type { DecodedLog } from "@bloke/chain-state";
import { type SinkDeps, toStatements } from "../src/sink.js";

const registry = "0x00000000000000000000000000000000000000aa";
const engine = "0x00000000000000000000000000000000000000bb";
const alice = "0x00000000000000000000000000000000000000a1";
const deps: SinkDeps = {
  registry,
  engine,
  blockTime: async () => 1_800_000_000n,
  readLot: async () => ({
    units: 10n ** 19n,
    entryPrice: 10n ** 20n,
    entryIndex: 1_000_000,
    fundingEntry: 0n,
    collateral: 1_000_000_000n,
    side: 1,
    owner: alice,
    marketId: 3,
    groupId: 0n,
  }),
};
const log = (eventName: string, address: string, args: Record<string, unknown>): DecodedLog => ({
  eventName,
  args,
  address: address as `0x${string}`,
  blockNumber: 5n,
  logIndex: 0,
  transactionHash: "0x1234",
});

describe("toStatements", () => {
  it("Listed → blokes insert with decoded ticker", async () => {
    const [s] = await toStatements(log("Listed", registry, { blokeId: 1, ticker: "0x464f554e444552000000000000000000", name: "Founder", tier: 1 }), deps);
    expect(s!.sql).toMatch(/INSERT INTO blokes/);
    expect(s!.params.slice(0, 4)).toEqual([1, "FOUNDER", "Founder", 1]);
  });

  it("the engine's Claimed is not mistaken for a profile claim", async () => {
    expect(await toStatements(log("Claimed", engine, { owner: alice, amount: 5n }), deps)).toEqual([]);
    const s = await toStatements(log("Claimed", registry, { blokeId: 1, wallet: alice, escrowMoved: 0n }), deps);
    expect(s).toHaveLength(2);
  });

  it("OrderFilled updates the order and inserts the lot from chain state", async () => {
    const s = await toStatements(log("OrderFilled", engine, { orderId: 9n, lotId: 12n, fillPrice: 1n, index: 1, premiumAfter: 0n }), deps);
    expect(s.map((x) => x.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual(["UPDATE orders SET", "INSERT INTO lots"]);
    expect(s[1]!.params[0]).toBe("12");
  });

  it("rejects record the reason name; LotClosed maps ProfitCapped", async () => {
    const [r] = await toStatements(log("OrderRejected", engine, { orderId: 9n, reason: 7 }), deps);
    expect(r!.params[1]).toBe("Lagging");
    const [u] = await toStatements(
      log("LotClosed", engine, { lotId: 12n, how: 4, exitPrice: 1n, pricePnl: 1n, fundingPnl: 0n, fee: 0n, creatorFee: 0n, payout: 1n }),
      deps,
    );
    expect(u!.params[1]).toBe("profit_capped");
  });
});
