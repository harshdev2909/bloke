import type { IndexEntry, IndexPush } from "@bloke/shared";
import { type OracleChain, type PushSigner, PushRejected } from "./chain.js";
import type { IndexSource, IndexTick } from "./source.js";

export interface PusherConfig {
  /** Push when any value moved at least this much since the last push (scaled ×1e4; 0.02 points = 200). */
  minChangeScaled: number;
  /** Push at least this often even when nothing changed (PRD §5.4). */
  heartbeatMs: number;
  /** Batch limit (oracle ORACLE_MAX_ENTRIES). */
  maxEntries: number;
  /** Consecutive failures before alerting. */
  alertAfterFailures: number;
}

export const DEFAULT_PUSHER_CONFIG: PusherConfig = {
  minChangeScaled: 200,
  heartbeatMs: 30_000,
  maxEntries: 32,
  alertAfterFailures: 3,
};

export type PushReason = "change" | "heartbeat" | "orders" | "lag";

export interface PusherEvents {
  pushed?(info: { seq: bigint; reason: PushReason; entries: number; txHash: string }): void;
  skipped?(info: { blokeId: number; reason: "stopped" }): void;
  failed?(info: { error: unknown; consecutive: number }): void;
  alert?(message: string): void;
}

/**
 * Decides when to push and builds, signs and submits pushes. One instance owns the sequence
 * number (the PRD's "single nonce manager"); a BadSeq revert triggers a resync from chain.
 */
export class Pusher {
  private nextSeq: bigint | undefined;
  private lastPushed = new Map<number, IndexTick>();
  private lastPushMs = 0;
  private lastTsMs = 0n;
  private failures = 0;
  private lagging = false;
  private inFlight = false;

  constructor(
    private readonly source: IndexSource,
    private readonly chain: OracleChain,
    private readonly signer: PushSigner,
    private readonly cfg: PusherConfig = DEFAULT_PUSHER_CONFIG,
    private readonly events: PusherEvents = {},
    /** Pending engine orders to settle with the next push (from EngineState). */
    private readonly pendingOrders: () => bigint[] = () => [],
  ) {}

  /** Called by the order watcher when OrderRequested arrives: push immediately. */
  async onOrdersPending(nowMs: number): Promise<boolean> {
    return this.tick(nowMs, true);
  }

  /** One scheduling step. Returns true if a push was submitted. */
  async tick(nowMs: number, ordersPending = false): Promise<boolean> {
    if (this.inFlight) return false;
    const ticks = this.source.latest(nowMs);
    const live = ticks.filter((t) => {
      if (t.stopped) this.events.skipped?.({ blokeId: t.blokeId, reason: "stopped" });
      return !t.stopped;
    });

    const orderIds = this.pendingOrders();
    const reason = this.reason(live, nowMs, ordersPending || orderIds.length > 0);
    if (!reason) return false;

    this.inFlight = true;
    try {
      if (this.nextSeq === undefined) this.nextSeq = (await this.chain.lastSeq()) + 1n;
      // tsMs must strictly increase even if the clock stalls between same-millisecond ticks.
      let tsMs = BigInt(nowMs);
      if (tsMs <= this.lastTsMs) tsMs = this.lastTsMs + 1n;

      let first = true;
      for (const batch of chunk(live, this.cfg.maxEntries)) {
        const push: IndexPush = {
          seq: this.nextSeq,
          tsMs,
          paramsVersion: this.source.paramsVersion(),
          entries: batch.map((t): IndexEntry => ({ blokeId: t.blokeId, b: t.b, h: t.h, w: t.w })),
        };
        const sig = await this.signer.signPush(push);
        // Orders settle with the first batch; later batches (> maxEntries Blokes) are plain pushes.
        const txHash = await this.chain.submit(push, sig, first ? orderIds : []);
        first = false;
        this.nextSeq += 1n;
        this.lastTsMs = tsMs;
        tsMs += 1n;
        for (const t of batch) this.lastPushed.set(t.blokeId, t);
        this.events.pushed?.({ seq: push.seq, reason, entries: batch.length, txHash });
      }
      this.lastPushMs = nowMs;
      this.failures = 0;
      this.lagging = (await this.chain.lagFlags(live.map((t) => t.blokeId))).some((l) => l.lagFlags !== 0);
      return true;
    } catch (error) {
      this.failures += 1;
      if (error instanceof PushRejected && (error.errorName === "BadSeq" || error.errorName === "StalePush")) {
        this.nextSeq = undefined; // resync; StalePush is fixed by re-signing with a fresh time next tick
      }
      this.events.failed?.({ error, consecutive: this.failures });
      if (this.failures === this.cfg.alertAfterFailures) {
        this.events.alert?.(`oracle-pusher: ${this.failures} consecutive push failures`);
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  private reason(live: IndexTick[], nowMs: number, ordersPending: boolean): PushReason | undefined {
    if (live.length === 0) return undefined;
    if (ordersPending) return "orders";
    // Amendment A1.4: while any applied value lags its raw value, push back to back to clear it.
    if (this.lagging) return "lag";
    if (nowMs - this.lastPushMs >= this.cfg.heartbeatMs) return "heartbeat";
    for (const t of live) {
      const p = this.lastPushed.get(t.blokeId);
      if (!p) return "change";
      const moved = Math.max(Math.abs(t.b - p.b), Math.abs(t.h - p.h), Math.abs(t.w - p.w));
      if (moved >= this.cfg.minChangeScaled) return "change";
    }
    return undefined;
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
