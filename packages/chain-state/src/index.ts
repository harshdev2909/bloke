import {
  type Abi,
  type Address,
  type BlockTag,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  parseEventLogs,
} from "viem";
import { blokePoolAbi, blokeRaiseAbi, blokeRegistryAbi, humanIndexOracleAbi, marketEngineAbi } from "@bloke/shared";

/** Every BLOKE event the services care about, in one ABI so logs decode in a single pass. */
export const ALL_EVENTS_ABI = [...marketEngineAbi, ...humanIndexOracleAbi, ...blokeRegistryAbi, ...blokePoolAbi, ...blokeRaiseAbi].filter(
  (x) => x.type === "event",
) as Abi;

export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

export interface LogReaderOptions {
  /** Max blocks per eth_getLogs call (public Monad RPCs limit the range). */
  chunk: bigint;
  /**
   * Block tag to read up to. The indexer uses "finalized" (PRD §13.1). Pusher and keeper may use
   * "latest" because every call they make re-checks state on chain and is idempotent.
   */
  tag: BlockTag;
}

/** Reads and decodes logs from a set of contracts, chunk by chunk, remembering where it stopped. */
export class LogReader {
  constructor(
    private readonly client: PublicClient<Transport, Chain | undefined>,
    private readonly addresses: Address[],
    public cursor: bigint,
    private readonly opts: LogReaderOptions = { chunk: 100n, tag: "latest" },
  ) {}

  /** Fetches up to `maxChunks` chunks after the cursor. Returns decoded logs in chain order. */
  async next(maxChunks = 50): Promise<{ logs: DecodedLog[]; toBlock: bigint; caughtUp: boolean }> {
    const head = (await this.client.getBlock({ blockTag: this.opts.tag })).number;
    if (head === null || head <= this.cursor) return { logs: [], toBlock: this.cursor, caughtUp: true };
    const out: DecodedLog[] = [];
    let from = this.cursor + 1n;
    for (let i = 0; i < maxChunks && from <= head; i++) {
      const to = from + this.opts.chunk - 1n > head ? head : from + this.opts.chunk - 1n;
      const raw = await this.client.getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
      const parsed = parseEventLogs({ abi: ALL_EVENTS_ABI, logs: raw, strict: false });
      for (const l of parsed) {
        if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null) continue;
        out.push({
          eventName: l.eventName as string,
          args: (l.args ?? {}) as Record<string, unknown>,
          address: l.address,
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          transactionHash: l.transactionHash,
        });
      }
      this.cursor = to;
      from = to + 1n;
    }
    return { logs: out, toBlock: this.cursor, caughtUp: this.cursor >= head };
  }
}

// ---------------------------------------------------------------- engine state

/** Mirrors MarketEngine enums. */
export const MarketStatus = ["None", "Shadow", "Live", "ReduceOnly", "Frozen", "SettleOnly", "Settled"] as const;
export const OrderKind = ["None", "Open", "Close"] as const;
export const LotStatus = ["None", "Open", "Closed", "Exhausted", "ProfitCapped", "Settled"] as const;
export const RejectReason = [
  "None",
  "Slippage",
  "NetCap",
  "GlobalCap",
  "FamilyCap",
  "Status",
  "Stale",
  "Lagging",
  "Group",
  "LotNotOpen",
] as const;

export interface PendingOrder {
  orderId: bigint;
  owner: Address;
  marketId: number;
  kind: "Open" | "Close";
  collateral: bigint;
  seqAtRequest: bigint;
  deadline: bigint;
  lotId: bigint;
  requestedBlock: bigint;
}

export interface OpenLot {
  lotId: bigint;
  owner: Address;
  marketId: number;
  collateral: bigint;
}

export interface MarketInfo {
  marketId: number;
  blokeId: number;
  leg: number;
  status: (typeof MarketStatus)[number];
}

/**
 * Pure reducer over engine events: pending orders, open lots and market statuses. Deterministic, so
 * the keeper, the pusher and tests share exactly the same view.
 */
export class EngineState {
  readonly pending = new Map<bigint, PendingOrder>();
  readonly openLots = new Map<bigint, OpenLot>();
  readonly markets = new Map<number, MarketInfo>();
  lastSeq = 0n;

  apply(log: DecodedLog): void {
    const a = log.args;
    switch (log.eventName) {
      case "MarketCreated":
        this.markets.set(Number(a.marketId), {
          marketId: Number(a.marketId),
          blokeId: Number(a.blokeId),
          leg: Number(a.leg),
          status: "Shadow",
        });
        break;
      case "MarketStatusChanged": {
        const m = this.markets.get(Number(a.marketId));
        if (m) m.status = MarketStatus[Number(a.status)] ?? "None";
        break;
      }
      case "OrderRequested":
        this.pending.set(a.orderId as bigint, {
          orderId: a.orderId as bigint,
          owner: a.owner as Address,
          marketId: Number(a.marketId),
          kind: OrderKind[Number(a.kind)] === "Close" ? "Close" : "Open",
          collateral: BigInt(a.collateral as bigint),
          seqAtRequest: BigInt(a.seqAtRequest as bigint),
          deadline: BigInt(a.deadline as bigint),
          lotId: BigInt(a.lotId as bigint),
          requestedBlock: log.blockNumber,
        });
        break;
      case "OrderFilled": {
        const o = this.pending.get(a.orderId as bigint);
        if (o?.kind === "Open") {
          this.openLots.set(a.lotId as bigint, {
            lotId: a.lotId as bigint,
            owner: o.owner,
            marketId: o.marketId,
            collateral: o.collateral,
          });
        }
        this.pending.delete(a.orderId as bigint);
        break;
      }
      case "OrderRejected":
      case "OrderCancelled":
      case "OrderExpired":
        this.pending.delete(a.orderId as bigint);
        break;
      case "LotClosed":
        this.openLots.delete(a.lotId as bigint);
        break;
      case "IndexPushed":
        this.lastSeq = BigInt(a.seq as bigint);
        break;
    }
  }

  applyAll(logs: DecodedLog[]): void {
    for (const l of logs) this.apply(l);
  }

  /** Pending orders a push would settle: requested before the current seq, or any if a push is about to land. */
  pendingIds(limit = 100): bigint[] {
    return [...this.pending.keys()].slice(0, limit);
  }

  expiredIds(nowSec: bigint, limit = 100): bigint[] {
    return [...this.pending.values()].filter((o) => o.deadline < nowSec).map((o) => o.orderId).slice(0, limit);
  }

  /** Serialisable snapshot (bigints as strings) so a restart resumes instead of replaying from deploy. */
  toJSON(cursor: bigint): EngineSnapshot {
    const big = (o: object) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
    return {
      version: 1,
      cursor: cursor.toString(),
      lastSeq: this.lastSeq.toString(),
      pending: big([...this.pending.values()]),
      openLots: big([...this.openLots.values()]),
      markets: [...this.markets.values()],
    };
  }

  static fromJSON(snap: EngineSnapshot): { state: EngineState; cursor: bigint } {
    const unbig = (o: unknown) =>
      JSON.parse(JSON.stringify(o), (_, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    const s = new EngineState();
    s.lastSeq = BigInt(snap.lastSeq);
    for (const o of unbig(snap.pending) as PendingOrder[]) s.pending.set(o.orderId, o);
    for (const l of unbig(snap.openLots) as OpenLot[]) s.openLots.set(l.lotId, l);
    for (const m of snap.markets) s.markets.set(m.marketId, m);
    return { state: s, cursor: BigInt(snap.cursor) };
  }

  lotsOn(statuses: (typeof MarketStatus)[number][]): OpenLot[] {
    return [...this.openLots.values()].filter((l) => statuses.includes(this.markets.get(l.marketId)?.status ?? "None"));
  }
}

export interface EngineSnapshot {
  version: 1;
  cursor: string;
  lastSeq: string;
  pending: unknown[];
  openLots: unknown[];
  markets: MarketInfo[];
}

export function decodeTicker(b: Hex): string {
  const bytes = Buffer.from(b.slice(2), "hex");
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("ascii");
}
