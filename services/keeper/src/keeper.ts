import type { Address } from "viem";
import type { EngineState } from "@bloke/chain-state";

/** One permissionless call the keeper wants to make. */
export type KeeperAction =
  | { fn: "expire"; ids: bigint[] }
  | { fn: "settle"; ids: bigint[] }
  | { fn: "exhaust"; ids: bigint[] }
  | { fn: "takeProfitCap"; ids: bigint[] }
  | { fn: "settleDelisted"; ids: bigint[] }
  | { fn: "poke"; marketIds: number[] }
  | { fn: "expireFreeze"; marketId: number }
  | { fn: "crankEpoch" }
  | { fn: "snapshotOi"; blokeIds: number[] };

export interface LotHealth {
  lotId: bigint;
  equity: bigint;
  pricePnl: bigint;
  fundingPnl: bigint;
  exhausted: boolean;
}

/** Chain reads the keeper needs beyond the event-derived state. */
export interface KeeperReads {
  lastSeq(): Promise<bigint>;
  lotHealth(lotIds: bigint[]): Promise<LotHealth[]>;
  frozenAt(marketId: number): Promise<bigint>;
  maxProfitBps(): Promise<bigint>;
  freezeMaxSec(): Promise<bigint>;
  /** When the current pool epoch can be cranked (unix seconds). */
  epochEndsAt(): Promise<bigint>;
}

export interface KeeperConfig {
  /** Fallback settle for orders the pusher hasn't settled after this many seconds. */
  settleFallbackSec: bigint;
  pokeEverySec: bigint;
  batch: number;
  /** Graduation OI readings (PRD §10.1 check 5); 0 when the deployment has no launcher. */
  snapshotOiEverySec: bigint;
}

export const DEFAULT_KEEPER_CONFIG: KeeperConfig = { settleFallbackSec: 3n, pokeEverySec: 300n, batch: 100, snapshotOiEverySec: 12n * 3600n };

const USDC_TO_WAD = 10n ** 12n;

/**
 * Decides what to call. Pure apart from reads, so every rule is unit-testable. Every action is
 * idempotent on chain (the engine re-checks state and skips stale ids), so running two keepers or
 * acting on a non-final block only wastes gas (PRD §13.1).
 */
export class Keeper {
  private lastPoke = 0n;
  private lastOiSnapshot = 0n;
  private readonly firstSeen = new Map<bigint, bigint>();

  constructor(
    private readonly state: EngineState,
    private readonly reads: KeeperReads,
    private readonly cfg: KeeperConfig = DEFAULT_KEEPER_CONFIG,
  ) {}

  async plan(nowSec: bigint): Promise<KeeperAction[]> {
    const actions: KeeperAction[] = [];
    const s = this.state;

    // Hourly waterfall (PRD §8.3): crank as soon as the epoch ends.
    if (nowSec >= (await this.reads.epochEndsAt())) actions.push({ fn: "crankEpoch" });

    const expired = s.expiredIds(nowSec, this.cfg.batch);
    if (expired.length) actions.push({ fn: "expire", ids: expired });

    // Fallback settlement: orders older than settleFallbackSec whose request predates the latest push.
    const seq = await this.reads.lastSeq();
    const stuck: bigint[] = [];
    for (const o of s.pending.values()) {
      if (o.deadline < nowSec) continue;
      const seen = this.firstSeen.get(o.orderId) ?? nowSec;
      this.firstSeen.set(o.orderId, seen);
      if (nowSec - seen >= this.cfg.settleFallbackSec && seq > o.seqAtRequest) stuck.push(o.orderId);
    }
    for (const id of this.firstSeen.keys()) if (!s.pending.has(id)) this.firstSeen.delete(id);
    if (stuck.length) actions.push({ fn: "settle", ids: stuck.slice(0, this.cfg.batch) });

    // Exhaustion and profit cap on tradable markets.
    const live = s.lotsOn(["Live", "ReduceOnly"]);
    if (live.length) {
      const health = await this.reads.lotHealth(live.map((l) => l.lotId));
      const capBps = await this.reads.maxProfitBps();
      const exhaust: bigint[] = [];
      const capped: bigint[] = [];
      for (const h of health) {
        const lot = s.openLots.get(h.lotId);
        if (!lot) continue;
        if (h.exhausted) exhaust.push(h.lotId);
        else if (h.pricePnl + h.fundingPnl >= (lot.collateral * USDC_TO_WAD * capBps) / 10_000n) capped.push(h.lotId);
      }
      if (exhaust.length) actions.push({ fn: "exhaust", ids: exhaust.slice(0, this.cfg.batch) });
      if (capped.length) actions.push({ fn: "takeProfitCap", ids: capped.slice(0, this.cfg.batch) });
    }

    // Delisted markets: settle every open lot at the snapshot price.
    const delisted = s.lotsOn(["SettleOnly"]);
    if (delisted.length) actions.push({ fn: "settleDelisted", ids: delisted.map((l) => l.lotId).slice(0, this.cfg.batch) });

    // Freezes older than FREEZE_MAX become SettleOnly.
    const frozen = [...s.markets.values()].filter((m) => m.status === "Frozen");
    if (frozen.length) {
      const max = await this.reads.freezeMaxSec();
      for (const m of frozen) {
        const at = await this.reads.frozenAt(m.marketId);
        if (at > 0n && nowSec >= at + max) actions.push({ fn: "expireFreeze", marketId: m.marketId });
      }
    }

    // Daily-ish OI readings for graduation; the launcher itself skips any Bloke read < 12 h ago.
    if (this.cfg.snapshotOiEverySec > 0n && nowSec - this.lastOiSnapshot >= this.cfg.snapshotOiEverySec) {
      const ids = [...new Set([...s.markets.keys()].map((m) => Math.floor(m / 3)))].sort((a, b) => a - b).slice(0, this.cfg.batch);
      if (ids.length) {
        actions.push({ fn: "snapshotOi", blokeIds: ids });
        this.lastOiSnapshot = nowSec;
      }
    }

    // Funding poke every 5 minutes bounds the error of holding the index between touches.
    if (nowSec - this.lastPoke >= this.cfg.pokeEverySec) {
      const ms = [...s.markets.values()].filter((m) => m.status === "Live" || m.status === "ReduceOnly").map((m) => m.marketId);
      if (ms.length) {
        for (let i = 0; i < ms.length; i += this.cfg.batch) actions.push({ fn: "poke", marketIds: ms.slice(i, i + this.cfg.batch) });
        this.lastPoke = nowSec;
      }
    }
    return actions;
  }
}

export type { Address };
