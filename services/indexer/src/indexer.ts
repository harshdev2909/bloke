import type { Address, Chain, PublicClient, Transport } from "viem";
import pg from "pg";
import { blokeRegistryAbi, humanIndexOracleAbi, marketEngineAbi } from "@bloke/shared";
import { LogReader } from "@bloke/chain-state";
import { type LotDetails, type SinkDeps, type StreamEvent, toStatements } from "./sink.js";

export interface IndexerAddresses {
  chainId: number;
  startBlock: number;
  registry: Address;
  oracle: Address;
  engine: Address;
  pool?: Address;
  raise?: Address;
}

/**
 * Reads every BLOKE event up to the Finalized block and writes it to Postgres. Each batch of logs
 * and the cursor commit in one transaction, so a crash resumes exactly where it stopped (PRD §13.1).
 */
export class Indexer {
  private reader: LogReader | undefined;
  private readonly blockTimes = new Map<bigint, bigint>();
  private readonly owners = new Map<bigint, Address>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly client: PublicClient<Transport, Chain | undefined>,
    private readonly a: IndexerAddresses,
    private readonly opts: { chunk: bigint; tag: "finalized" | "latest" } = { chunk: 100n, tag: "finalized" },
    /** Publishes committed events (Redis in production); omitted in tests. */
    private readonly onEvents?: (events: StreamEvent[]) => Promise<void>,
  ) {}

  private deps(events: StreamEvent[]): SinkDeps {
    return {
      registry: this.a.registry,
      engine: this.a.engine,
      ...(this.a.pool && { pool: this.a.pool }),
      ...(this.a.raise && { raise: this.a.raise }),
      publish: (e) => events.push(e),
      readOracle: async (block) => {
        const count = await this.client.readContract({
          address: this.a.registry,
          abi: blokeRegistryAbi,
          functionName: "blokeCount",
          blockNumber: block,
        });
        const ids = Array.from({ length: count }, (_, i) => i + 1);
        const rows = await Promise.all(
          ids.map((id) =>
            this.client.readContract({ address: this.a.oracle, abi: humanIndexOracleAbi, functionName: "latest", args: [id], blockNumber: block }),
          ),
        );
        return rows.map((r, i) => ({ blokeId: ids[i]!, b: r.b, h: r.h, w: r.w, lagFlags: r.lagFlags }));
      },
      orderOwner: async (orderId, block) => {
        const cached = this.owners.get(orderId);
        if (cached) return cached;
        const o = await this.client.readContract({ address: this.a.engine, abi: marketEngineAbi, functionName: "order", args: [orderId], blockNumber: block });
        this.owners.set(orderId, o.owner);
        return o.owner;
      },
      blockTime: async (b) => {
        let t = this.blockTimes.get(b);
        if (t === undefined) {
          t = (await this.client.getBlock({ blockNumber: b })).timestamp;
          this.blockTimes.set(b, t);
          if (this.blockTimes.size > 10_000) this.blockTimes.clear();
        }
        return t;
      },
      readLot: async (lotId, block): Promise<LotDetails> => {
        const l = await this.client.readContract({
          address: this.a.engine,
          abi: marketEngineAbi,
          functionName: "lot",
          args: [lotId],
          blockNumber: block,
        });
        return {
          units: l.units,
          entryPrice: l.entryPrice,
          entryIndex: l.entryIndex,
          fundingEntry: l.fundingEntry,
          collateral: l.collateral,
          side: l.side,
          owner: l.owner,
          marketId: l.marketId,
          groupId: l.groupId,
        };
      },
    };
  }

  async cursor(): Promise<bigint> {
    const r = await this.pool.query<{ block_number: string }>(`SELECT block_number FROM indexer_cursor WHERE chain_id = $1`, [
      this.a.chainId,
    ]);
    return r.rows[0] ? BigInt(r.rows[0].block_number) : BigInt(this.a.startBlock) - 1n;
  }

  /** Processes one batch. Returns the number of logs written and whether the indexer is at the head. */
  async step(): Promise<{ logs: number; caughtUp: boolean; block: bigint }> {
    if (!this.reader) {
      this.reader = new LogReader(
        this.client,
        [this.a.registry, this.a.oracle, this.a.engine, ...(this.a.pool ? [this.a.pool] : []), ...(this.a.raise ? [this.a.raise] : [])],
        await this.cursor(),
        this.opts,
      );
    }
    const { logs, toBlock, caughtUp } = await this.reader.next(10);
    const events: StreamEvent[] = [];
    const deps = this.deps(events);
    const stmts = [];
    for (const l of logs) {
      if (l.eventName === "OrderRequested") {
        this.owners.set(l.args.orderId as bigint, l.args.owner as Address);
        if (this.owners.size > 50_000) this.owners.clear();
      }
      stmts.push(...(await toStatements(l, deps)));
    }

    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const s of stmts) await c.query(s.sql, s.params);
      const hash = toBlock >= 0n ? (await this.client.getBlock({ blockNumber: toBlock })).hash : null;
      await c.query(
        `INSERT INTO indexer_cursor (chain_id, block_number, block_hash) VALUES ($1,$2,$3)
         ON CONFLICT (chain_id) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`,
        [this.a.chainId, toBlock.toString(), hash ? Buffer.from(hash.slice(2), "hex") : Buffer.alloc(0)],
      );
      await c.query("COMMIT");
    } catch (err) {
      events.length = 0;
      await c.query("ROLLBACK");
      this.reader = undefined; // re-read from the committed cursor
      throw err;
    } finally {
      c.release();
    }
    // Publish only after commit, so subscribers never see an event the database doesn't have.
    if (events.length && this.onEvents) await this.onEvents(events).catch(() => undefined);
    return { logs: logs.length, caughtUp, block: toBlock };
  }
}
