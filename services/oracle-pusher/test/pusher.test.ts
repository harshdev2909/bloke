import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { IndexPush } from "@bloke/shared";
import { type LagState, type OracleChain, type PushSigner, PushRejected } from "../src/chain.js";
import { DEFAULT_PUSHER_CONFIG, Pusher } from "../src/pusher.js";
import { type IndexSource, type IndexTick, SyntheticSource } from "../src/source.js";

class FakeChain implements OracleChain {
  seq = 0n;
  pushes: IndexPush[] = [];
  lag = 0;
  failNext: string[] = [];
  async lastSeq() {
    return this.seq;
  }
  async lagFlags(ids: number[]): Promise<LagState[]> {
    return ids.map((blokeId) => ({ blokeId, lagFlags: this.lag }));
  }
  settled: bigint[][] = [];
  async submit(push: IndexPush, _sig: Hex, orderIds: bigint[] = []): Promise<Hex> {
    this.settled.push(orderIds);
    const fail = this.failNext.shift();
    if (fail) throw new PushRejected(fail);
    if (push.seq !== this.seq + 1n) throw new PushRejected("BadSeq");
    this.seq = push.seq;
    this.pushes.push(push);
    return "0x01";
  }
}

const signer: PushSigner = { address: () => "0x0000000000000000000000000000000000000001", signPush: async () => "0xsig" };

class FixedSource implements IndexSource {
  constructor(public ticks: IndexTick[]) {}
  paramsVersion() {
    return "0x00" as const;
  }
  latest() {
    return this.ticks;
  }
}
const tick = (blokeId: number, v: number, stopped = false): IndexTick => ({ blokeId, b: v, h: v, w: v, stopped });

describe("Pusher", () => {
  it("pushes first, then only on change ≥ 0.02 points or heartbeat", async () => {
    const chain = new FakeChain();
    const src = new FixedSource([tick(1, 1_000_000)]);
    const p = new Pusher(src, chain, signer);
    expect(await p.tick(0)).toBe(true);
    expect(await p.tick(1_000)).toBe(false);
    src.ticks = [tick(1, 1_000_199)];
    expect(await p.tick(2_000)).toBe(false);
    src.ticks = [tick(1, 1_000_200)];
    expect(await p.tick(3_000)).toBe(true);
    expect(await p.tick(32_999)).toBe(false);
    expect(await p.tick(33_000)).toBe(true); // heartbeat
    expect(chain.pushes.map((x) => x.seq)).toEqual([1n, 2n, 3n]);
  });

  it("pushes at once when orders are pending", async () => {
    const chain = new FakeChain();
    const p = new Pusher(new FixedSource([tick(1, 1_000_000)]), chain, signer);
    await p.tick(0);
    expect(await p.onOrdersPending(100)).toBe(true);
  });

  it("keeps pushing back to back while the oracle reports lag (A1.4)", async () => {
    const chain = new FakeChain();
    chain.lag = 1;
    const p = new Pusher(new FixedSource([tick(1, 1_500_000)]), chain, signer);
    await p.tick(0);
    expect(await p.tick(300)).toBe(true);
    chain.lag = 0;
    expect(await p.tick(600)).toBe(true); // this push observes lag cleared
    expect(await p.tick(900)).toBe(false);
  });

  it("pushes immediately with pending engine orders and settles them in the same tx", async () => {
    const chain = new FakeChain();
    let pending: bigint[] = [];
    const p = new Pusher(new FixedSource([tick(1, 1_000_000)]), chain, signer, DEFAULT_PUSHER_CONFIG, {}, () => pending);
    await p.tick(0);
    expect(await p.tick(500)).toBe(false);
    pending = [42n, 43n];
    expect(await p.tick(600)).toBe(true);
    expect(chain.settled.at(-1)).toEqual([42n, 43n]);
  });

  it("never pushes stopped Blokes", async () => {
    const chain = new FakeChain();
    const p = new Pusher(new FixedSource([tick(1, 1_000_000), tick(2, 1_000_000, true)]), chain, signer);
    await p.tick(0);
    expect(chain.pushes[0]!.entries.map((e) => e.blokeId)).toEqual([1]);
  });

  it("splits large sets into batches of maxEntries with consecutive seqs", async () => {
    const chain = new FakeChain();
    const ticks = Array.from({ length: 40 }, (_, i) => tick(i + 1, 1_000_000));
    const p = new Pusher(new FixedSource(ticks), chain, signer);
    await p.tick(0);
    expect(chain.pushes.map((x) => x.entries.length)).toEqual([32, 8]);
    expect(chain.pushes[1]!.tsMs).toBeGreaterThan(chain.pushes[0]!.tsMs);
  });

  it("resyncs seq after BadSeq (another relayer pushed) and alerts after 3 failures", async () => {
    const chain = new FakeChain();
    const alerts: string[] = [];
    const p = new Pusher(new FixedSource([tick(1, 1_000_000)]), chain, signer, DEFAULT_PUSHER_CONFIG, { alert: (m) => alerts.push(m) });
    await p.tick(0);
    chain.seq = 5n; // someone else relayed pushes 2..5
    expect(await p.tick(31_000)).toBe(false);
    expect(await p.tick(31_100)).toBe(true);
    expect(chain.pushes.at(-1)!.seq).toBe(6n);

    chain.failNext = ["X", "X", "X"];
    for (let i = 0; i < 3; i++) await p.tick(70_000 + i * 31_000);
    expect(alerts).toHaveLength(1);
  });

  it("tsMs strictly increases even when the clock repeats", async () => {
    const chain = new FakeChain();
    const p = new Pusher(new FixedSource([tick(1, 1_000_000)]), chain, signer);
    await p.tick(1_000);
    await p.onOrdersPending(1_000);
    expect(chain.pushes[1]!.tsMs).toBe(1_001n);
  });

  it("synthetic source resumes from on-chain values instead of jumping to 100", () => {
    const src = new SyntheticSource([1], 7);
    src.seed(1, 1_300_000, 800_000);
    const [t] = src.latest(0);
    expect(t!.h).toBe(1_300_000);
    expect(t!.w).toBe(800_000);
    expect(t!.b).toBe(Math.round((0.35 * 1.3 + 0.65 * 0.8) * 1e6));
  });

  it("synthetic source is deterministic and stays in range", () => {
    const a = new SyntheticSource([1, 2], 42);
    const b = new SyntheticSource([1, 2], 42);
    for (let t = 0; t < 10_000 * 60_000; t += 60_000) {
      const ta = a.latest(t);
      const tb = b.latest(t);
      expect(ta).toEqual(tb);
      for (const x of ta) {
        expect(x.b).toBeGreaterThan(0);
        expect(x.b).toBeLessThan(2_000_000);
      }
    }
  });
});
