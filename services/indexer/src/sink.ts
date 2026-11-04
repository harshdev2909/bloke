import type { Address, Hex } from "viem";
import { type DecodedLog, LotStatus, OrderKind, RejectReason, decodeTicker } from "@bloke/chain-state";
import type { StreamEvent } from "@bloke/shared";
export type { StreamEvent };

/** A parameterised SQL statement. */
export interface Stmt {
  sql: string;
  params: unknown[];
}

export interface LotDetails {
  units: bigint;
  entryPrice: bigint;
  entryIndex: number;
  fundingEntry: bigint;
  collateral: bigint;
  side: number;
  owner: Address;
  marketId: number;
  groupId: bigint;
}

export interface OracleRow {
  blokeId: number;
  b: number;
  h: number;
  w: number;
  lagFlags: number;
}

export interface SinkDeps {
  registry: Address;
  engine: Address;
  pool?: Address;
  raise?: Address;
  /** Applied oracle values of every listed Bloke as of a block (charts need applied, not raw). */
  readOracle?(block: bigint): Promise<OracleRow[]>;
  /** Owner of an order (cached from OrderRequested, else read from chain). */
  orderOwner?(orderId: bigint, block: bigint): Promise<Address>;
  /** Collects stream events; the indexer publishes them after commit. */
  publish?(e: StreamEvent): void;
  /** Block timestamp (seconds) for a block number. */
  blockTime(block: bigint): Promise<bigint>;
  /** Lot struct as of a block (for fields not carried by events). */
  readLot(lotId: bigint, block: bigint): Promise<LotDetails>;
}

const hexBuf = (h: Hex | Address) => Buffer.from(h.slice(2), "hex");
const ts = (sec: bigint) => new Date(Number(sec) * 1000);
const num = (x: unknown) => (x as bigint).toString();

const BLOKE_STATUS: Record<string, string> = {
  WentLive: "live",
  Delisted: "delisted",
  Graduated: "graduated",
};

/**
 * Translates one decoded log into SQL. Idempotent: every insert uses ON CONFLICT so replaying a
 * range after a crash is harmless (the cursor commits in the same transaction anyway).
 */
export async function toStatements(log: DecodedLog, deps: SinkDeps): Promise<Stmt[]> {
  const a = log.args;
  const tx = hexBuf(log.transactionHash);
  const isRegistry = log.address.toLowerCase() === deps.registry.toLowerCase();
  const isEngine = log.address.toLowerCase() === deps.engine.toLowerCase();

  switch (log.eventName) {
    // ------------------------------------------------------------ registry
    case "Listed": {
      if (!isRegistry) return [];
      const t = await deps.blockTime(log.blockNumber);
      return [
        {
          sql: `INSERT INTO blokes (id, ticker, name, tier, status, listed_at) VALUES ($1,$2,$3,$4,'shadow',$5)
                ON CONFLICT (id) DO NOTHING`,
          params: [Number(a.blokeId), decodeTicker(a.ticker as Hex), a.name, Number(a.tier), ts(t)],
        },
      ];
    }
    case "WentLive":
    case "Delisted":
    case "Graduated": {
      if (!isRegistry) return [];
      deps.publish?.({ type: "bloke", blokeId: Number(a.blokeId), status: BLOKE_STATUS[log.eventName]! });
      const t = await deps.blockTime(log.blockNumber);
      const extra = log.eventName === "WentLive" ? ", live_at = $3" : "";
      return [
        {
          sql: `UPDATE blokes SET status = $2::bloke_status${extra} WHERE id = $1`,
          params: log.eventName === "WentLive" ? [Number(a.blokeId), BLOKE_STATUS[log.eventName], ts(t)] : [Number(a.blokeId), BLOKE_STATUS[log.eventName]],
        },
      ];
    }
    case "DelistRequested":
      if (!isRegistry) return [];
      return [
        {
          sql: `UPDATE blokes SET status = 'delist_pending', settle_b = $2, settle_h = $3, settle_w = $4 WHERE id = $1`,
          params: [Number(a.blokeId), Number(a.b), Number(a.h), Number(a.w)],
        },
      ];
    case "DelistRejected":
      if (!isRegistry) return [];
      return [
        {
          sql: `UPDATE blokes SET status = CASE WHEN live_at IS NULL THEN 'shadow'::bloke_status ELSE 'live'::bloke_status END,
                settle_b = NULL, settle_h = NULL, settle_w = NULL WHERE id = $1`,
          params: [Number(a.blokeId)],
        },
      ];
    case "Claimed": {
      if (!isRegistry) return []; // the engine's Claimed (payout withdrawals) has no table
      const t = await deps.blockTime(log.blockNumber);
      const wallet = hexBuf(a.wallet as Address);
      return [
        { sql: `UPDATE blokes SET claimed_wallet = $2, claimed_at = $3 WHERE id = $1`, params: [Number(a.blokeId), wallet, ts(t)] },
        {
          sql: `INSERT INTO linked_wallets (bloke_id, wallet, source) VALUES ($1,$2,'claimed') ON CONFLICT DO NOTHING`,
          params: [Number(a.blokeId), wallet],
        },
      ];
    }
    case "SourcesVerified": {
      if (!isRegistry) return [];
      const id = Number(a.blokeId);
      return [
        { sql: `DELETE FROM linked_wallets WHERE bloke_id = $1 AND source = 'deployer'`, params: [id] },
        ...(a.linked as Address[]).map((w) => ({
          sql: `INSERT INTO linked_wallets (bloke_id, wallet, source) VALUES ($1,$2,'deployer') ON CONFLICT DO NOTHING`,
          params: [id, hexBuf(w)],
        })),
      ];
    }
    case "CreatorFeeCredited":
    case "CreatorFeesWithdrawn":
      if (!isRegistry) return [];
      return [
        {
          sql: `INSERT INTO creator_fees (bloke_id, amount, kind, tx_hash) VALUES ($1,$2,$3,$4)`,
          params: [Number(a.blokeId), num(a.amount), log.eventName === "CreatorFeeCredited" ? "credit" : "withdraw", tx],
        },
      ];

    // ------------------------------------------------------------ oracle
    case "IndexPushed": {
      const out: Stmt[] = [
        {
          sql: `INSERT INTO oracle_pushes (seq, ts_ms, params_version, entries, tx_hash, block_number)
                VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (seq) DO NOTHING`,
          params: [num(a.seq), num(a.tsMs), hexBuf(a.paramsVersion as Hex), Number(a.count), tx, log.blockNumber.toString()],
        },
      ];
      deps.publish?.({ type: "push", seq: num(a.seq), tsMs: num(a.tsMs), entries: Number(a.count) });
      if (deps.readOracle) {
        const at = new Date(Number(a.tsMs as bigint));
        for (const r of await deps.readOracle(log.blockNumber)) {
          if (r.b === 0) continue;
          out.push({
            sql: `INSERT INTO oracle_values (seq, bloke_id, b, h, w, lag_flags, clamped, ts)
                  SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE EXISTS (SELECT 1 FROM blokes WHERE id = $2)
                  ON CONFLICT (seq, bloke_id) DO NOTHING`,
            params: [num(a.seq), r.blokeId, r.b, r.h, r.w, r.lagFlags, r.lagFlags !== 0, at],
          });
          deps.publish?.({ type: "index", blokeId: r.blokeId, b: r.b, h: r.h, w: r.w, lagFlags: r.lagFlags, seq: num(a.seq), tsMs: num(a.tsMs) });
        }
      }
      return out;
    }

    // ------------------------------------------------------------ engine
    case "OrderRequested": {
      if (!isEngine) return [];
      const t = await deps.blockTime(log.blockNumber);
      deps.publish?.({ type: "order", owner: a.owner as Address, orderId: num(a.orderId), marketId: Number(a.marketId), status: "requested", txHash: log.transactionHash });
      return [
        {
          sql: `INSERT INTO orders (id, owner, market_id, side, kind, collateral, seq_at_request, status, requested_tx, requested_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) ON CONFLICT (id) DO NOTHING`,
          params: [
            num(a.orderId),
            hexBuf(a.owner as Address),
            Number(a.marketId),
            Number(a.side),
            (OrderKind[Number(a.kind)] ?? "None").toLowerCase(),
            num(a.collateral),
            num(a.seqAtRequest),
            tx,
            ts(t),
          ],
        },
      ];
    }
    case "SpreadLinked": {
      const g = (a.workOrder as bigint) < (a.hypeOrder as bigint) ? a.workOrder : a.hypeOrder;
      return [
        {
          sql: `UPDATE orders SET kind = 'spread', group_id = $3 WHERE id IN ($1, $2)`,
          params: [num(a.workOrder), num(a.hypeOrder), num(g)],
        },
      ];
    }
    case "OrderFilled": {
      if (!isEngine) return [];
      const t = await deps.blockTime(log.blockNumber);
      const out: Stmt[] = [
        {
          sql: `UPDATE orders SET status = 'filled', final_tx = $2, final_at = $3 WHERE id = $1`,
          params: [num(a.orderId), tx, ts(t)],
        },
      ];
      const lotId = a.lotId as bigint;
      // An open fill creates the lot; a close fill's lot row is updated by LotClosed.
      const lot = await deps.readLot(lotId, log.blockNumber);
      if (deps.publish) {
        const owner = deps.orderOwner ? await deps.orderOwner(a.orderId as bigint, log.blockNumber) : lot.owner;
        deps.publish({ type: "order", owner, orderId: num(a.orderId), status: "filled", lotId: lotId.toString(), fillPrice: num(a.fillPrice), txHash: log.transactionHash });
      }
      if (lot.units > 0n) {
        out.push({
          sql: `INSERT INTO lots (id, owner, market_id, side, collateral, units, entry_price, entry_index, funding_entry,
                  group_id, status, opened_at, open_tx)
                SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12
                WHERE NOT EXISTS (SELECT 1 FROM lots WHERE id = $1)`,
          params: [
            lotId.toString(),
            hexBuf(lot.owner),
            lot.marketId,
            lot.side,
            lot.collateral.toString(),
            lot.units.toString(),
            lot.entryPrice.toString(),
            lot.entryIndex,
            lot.fundingEntry.toString(),
            lot.groupId === 0n ? null : lot.groupId.toString(),
            ts(t),
            tx,
          ],
        });
      }
      return out;
    }
    case "OrderRejected": {
      const t = await deps.blockTime(log.blockNumber);
      await publishOrder(log, deps, "rejected", RejectReason[Number(a.reason)] ?? "Unknown");
      return [
        {
          sql: `UPDATE orders SET status = 'rejected', reject_reason = $2, final_tx = $3, final_at = $4 WHERE id = $1`,
          params: [num(a.orderId), RejectReason[Number(a.reason)] ?? "Unknown", tx, ts(t)],
        },
      ];
    }
    case "OrderDeferred":
      await publishOrder(log, deps, "deferred", RejectReason[Number(a.reason)] ?? "Unknown");
      return [{ sql: `UPDATE orders SET status = 'deferred' WHERE id = $1 AND status = 'pending'`, params: [num(a.orderId)] }];
    case "OrderCancelled":
    case "OrderExpired": {
      const t = await deps.blockTime(log.blockNumber);
      await publishOrder(log, deps, log.eventName === "OrderCancelled" ? "cancelled" : "expired");
      return [
        {
          sql: `UPDATE orders SET status = $2::order_status, final_tx = $3, final_at = $4 WHERE id = $1`,
          params: [num(a.orderId), log.eventName === "OrderCancelled" ? "cancelled" : "expired", tx, ts(t)],
        },
      ];
    }
    case "LotClosed": {
      if (!isEngine) return [];
      const t = await deps.blockTime(log.blockNumber);
      const how = (LotStatus[Number(a.how)] ?? "Closed")
        .replace("ProfitCapped", "profit_capped")
        .toLowerCase();
      if (deps.publish) {
        const lot = await deps.readLot(a.lotId as bigint, log.blockNumber);
        deps.publish({
          type: "lot",
          owner: lot.owner,
          lotId: num(a.lotId),
          marketId: lot.marketId,
          status: how,
          exitPrice: num(a.exitPrice),
          pricePnl: num(a.pricePnl),
          fundingPnl: num(a.fundingPnl),
          fee: num(a.fee),
          payout: num(a.payout),
          txHash: log.transactionHash,
        });
      }
      return [
        { sql: `UPDATE lots SET status = $2::lot_status WHERE id = $1`, params: [num(a.lotId), how] },
        {
          sql: `INSERT INTO closes (lot_id, exit_price, price_pnl, funding_pnl, fee, creator_fee, payout, closed_at, tx_hash)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (lot_id) DO NOTHING`,
          params: [
            num(a.lotId),
            num(a.exitPrice),
            num(a.pricePnl),
            num(a.fundingPnl),
            num(a.fee),
            num(a.creatorFee),
            num(a.payout),
            ts(t),
            tx,
          ],
        },
      ];
    }
    // ------------------------------------------------------------ pool (P2)
    case "EpochSettled": {
      if (!deps.pool || log.address.toLowerCase() !== deps.pool.toLowerCase()) return [];
      const t = await deps.blockTime(log.blockNumber);
      deps.publish?.({ type: "epoch", epoch: num(a.epoch), g: num(a.g) });
      return [
        {
          sql: `INSERT INTO epochs (n, g, fee, d_reserve, d_treasury, floor_accrual, d_edge, skin_absorbed, impairment, tx_hash, settled_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (n) DO NOTHING`,
          params: [num(a.epoch), num(a.g), num(a.fee), num(a.dReserve), num(a.dTreasury), num(a.floorAccrual), num(a.dEdge), num(a.skinAbsorbed), num(a.impairment), tx, ts(t)],
        },
      ];
    }
    case "DepositRequested":
    case "RedeemRequested":
    case "Subscribed": {
      if (!deps.pool || log.address.toLowerCase() !== deps.pool.toLowerCase()) return [];
      const deck = log.eventName === "Subscribed" ? "floor" : "edge";
      const kind = log.eventName === "Subscribed" ? "subscribe" : log.eventName === "DepositRequested" ? "deposit" : "redeem";
      const amount = log.eventName === "RedeemRequested" ? a.shares : log.eventName === "Subscribed" ? a.amount : a.assets;
      return [
        {
          sql: `INSERT INTO deck_requests (wallet, deck, kind, amount, epoch, status) VALUES ($1,$2,$3,$4,$5,'queued')`,
          params: [hexBuf(a.who as Address), deck, kind, num(amount), log.eventName === "Subscribed" ? Number(a.id) : num(a.epoch)],
        },
      ];
    }
    case "SkinPosted":
    case "SkinAbsorbed":
    case "SkinWithdrawn": {
      if (!deps.pool || log.address.toLowerCase() !== deps.pool.toLowerCase()) return [];
      const kind = log.eventName === "SkinPosted" ? "post" : log.eventName === "SkinAbsorbed" ? "absorb" : "withdraw";
      return [
        {
          sql: `INSERT INTO skin_events (bloke_id, amount, kind, tx_hash) VALUES ($1,$2,$3,$4)`,
          params: [Number(a.blokeId), num(a.amount), kind, tx],
        },
      ];
    }
    // ---------------------------------------------------------------- raises (A18)
    case "RaiseOpened": {
      if (!deps.raise || log.address.toLowerCase() !== deps.raise.toLowerCase()) return [];
      const t = await deps.blockTime(log.blockNumber);
      return [
        {
          sql: `INSERT INTO raises (id, bloke_id, person, goal, min_commit, opened_at, deadline, tx_hash)
                VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8) ON CONFLICT (id) DO NOTHING`,
          params: [num(a.id), Number(a.blokeId), hexBuf(a.person as Address), num(a.goal), num(a.minCommit), ts(t), Number(a.deadline), tx],
        },
      ];
    }
    case "Committed":
    case "Refunded": {
      if (!deps.raise || log.address.toLowerCase() !== deps.raise.toLowerCase()) return [];
      const t = await deps.blockTime(log.blockNumber);
      const commit = log.eventName === "Committed";
      return [
        {
          sql: `INSERT INTO raise_events (raise_id, wallet, kind, amount, at, tx_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
          params: [num(a.id), hexBuf(a.backer as Address), commit ? "commit" : "refund", num(a.amount), ts(t), tx],
        },
        ...(commit ? [{ sql: `UPDATE raises SET raised = $2 WHERE id = $1`, params: [num(a.id), num(a.raised)] }] : []),
      ];
    }
    case "RaiseSucceeded":
    case "RaiseCancelled":
    case "Withdrawn": {
      if (!deps.raise || log.address.toLowerCase() !== deps.raise.toLowerCase()) return [];
      const state = log.eventName === "RaiseSucceeded" ? "succeeded" : log.eventName === "RaiseCancelled" ? "cancelled" : "withdrawn";
      return [{ sql: `UPDATE raises SET state = $2 WHERE id = $1`, params: [num(a.id), state] }];
    }
    default:
      return [];
  }
}

async function publishOrder(
  log: DecodedLog,
  deps: SinkDeps,
  status: "rejected" | "cancelled" | "expired" | "deferred",
  reason?: string,
): Promise<void> {
  if (!deps.publish || !deps.orderOwner) return;
  const orderId = log.args.orderId as bigint;
  const owner = await deps.orderOwner(orderId, log.blockNumber);
  deps.publish({ type: "order", owner, orderId: orderId.toString(), status, ...(reason && { reason }), txHash: log.transactionHash });
}
