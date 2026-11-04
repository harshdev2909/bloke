import type { FastifyInstance } from "fastify";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { ARCHETYPES, type ArchetypeId, type SourceKind, blokePoolAbi, deriveArchetype, humanIndexOracleAbi, marketEngineAbi, poolShareAbi, testUSDCAbi } from "@bloke/shared";
import type { BlokeDetail, BlokeSummary, DeckPosition, EpochRow, FloorSeriesView, GraduationCheck, Lot, Order, PoolView, StatusView, Trade, WalletView } from "@bloke/sdk";
import { LEGS, configValue, headBlock, markets, oracleLatest, registryBloke } from "../chain.js";
import type { Ctx } from "../context.js";
import * as grad from "../graduation.js";
import { badRequest, bufToHex, hexToBuf, meta, notFound } from "../http.js";

interface BlokeRow {
  id: number;
  ticker: string;
  name: string;
  tier: number;
  status: BlokeSummary["status"];
  claimed_wallet: Buffer | null;
  b_1h: number | null;
  settle_b: number | null;
  settle_h: number | null;
  settle_w: number | null;
  archetype: ArchetypeId | null;
  source_kinds: SourceKind[] | null;
}

const BLOKES_SQL = `
  SELECT b.id, b.ticker, b.name, b.tier, b.status, b.claimed_wallet, b.settle_b, b.settle_h, b.settle_w, b.archetype,
         (SELECT array_agg(DISTINCT s.kind::text) FROM bloke_sources s WHERE s.bloke_id = b.id AND s.enabled) AS source_kinds,
         (SELECT v.b FROM oracle_values v WHERE v.bloke_id = b.id AND v.ts <= now() - interval '1 hour'
           ORDER BY v.ts DESC LIMIT 1) AS b_1h
  FROM blokes b`;

function badge(h: number, w: number): BlokeSummary["badge"] {
  if (w - h >= 100_000) return "underrated";
  if (h - w >= 100_000) return "overhyped";
  return null;
}

async function summaries(ctx: Ctx, rows: BlokeRow[]): Promise<BlokeSummary[]> {
  const latest = rows.length ? await oracleLatest(ctx, rows.map((r) => r.id)) : new Map();
  return rows.map((r) => {
    const idx = latest.get(r.id) ?? null;
    const live = idx && idx.b > 0 ? idx : null;
    return {
      id: r.id,
      ticker: r.ticker,
      name: r.name,
      tier: r.tier,
      status: r.status,
      claimed: r.claimed_wallet !== null,
      index: live,
      change1h: live && r.b_1h ? live.b - r.b_1h : null,
      badge: live ? badge(live.h, live.w) : null,
      archetype: r.archetype ?? deriveArchetype(r.source_kinds ?? []),
    };
  });
}

const RANGES = {
  "1h": { interval: "1 hour", bucket: "1 minute" },
  "24h": { interval: "24 hours", bucket: "5 minutes" },
  "7d": { interval: "7 days", bucket: "1 hour" },
  "30d": { interval: "30 days", bucket: "1 hour" },
} as const;

export function registerReads(app: FastifyInstance, ctx: Ctx) {
  app.get("/v1/blokes", async () => {
    const rows = (await ctx.db.query<BlokeRow>(`${BLOKES_SQL} ORDER BY b.id`)).rows;
    return { data: await summaries(ctx, rows), meta: meta({ index: "on-chain", change1h: "indexed", profile: "indexed" }) };
  });

  /** The archetype catalogue with how many Blokes on the floor belong to each. */
  app.get("/v1/archetypes", async () => {
    const rows = (await ctx.db.query<BlokeRow>(`${BLOKES_SQL} WHERE b.status <> 'delisted'`)).rows;
    const count = new Map<string, number>();
    for (const r of rows) {
      const a = r.archetype ?? deriveArchetype(r.source_kinds ?? []);
      if (a) count.set(a, (count.get(a) ?? 0) + 1);
    }
    return { data: ARCHETYPES.map((a) => ({ ...a, blokes: count.get(a.id) ?? 0 })), meta: meta({ archetypes: "indexed" }) };
  });

  app.get("/v1/blokes/:ticker", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10) }).parse(req.params);
    const row = (await ctx.db.query<BlokeRow>(`${BLOKES_SQL} WHERE b.ticker = $1`, [ticker.toUpperCase()])).rows[0];
    if (!row) throw notFound(`Bloke ${ticker}`);
    const [summary] = await summaries(ctx, [row]);
    const [ms, reg, sources, grad] = await Promise.all([
      markets(ctx, row.id),
      registryBloke(ctx, row.id),
      ctx.db.query<{ kind: string; handle: string | null; verified: boolean }>(`SELECT kind::text, handle, verified FROM bloke_sources WHERE bloke_id = $1 ORDER BY kind`, [row.id]),
      graduationChecks(ctx, row.id),
    ]);
    const detail: BlokeDetail = {
      ...summary!,
      claimedWallet: reg.wallet === "0x0000000000000000000000000000000000000000" ? null : reg.wallet,
      sources: sources.rows,
      markets: ms,
      settlePrice: reg.settlePrice[0] ? { b: reg.settlePrice[0], h: reg.settlePrice[1], w: reg.settlePrice[2] } : null,
      graduation: grad,
    };
    return { data: detail, meta: meta({ index: "on-chain", markets: "on-chain", sources: "indexed", graduation: "on-chain" }, await headBlock(ctx)) };
  });

  app.get("/v1/blokes/:ticker/index", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10) }).parse(req.params);
    const q = z.object({ leg: z.enum(["blend", "hype", "work"]).default("blend"), range: z.enum(["1h", "24h", "7d", "30d"]).default("24h") }).parse(req.query);
    const r = RANGES[q.range];
    const rows = await ctx.db.query<{ t: Date; b: number; h: number; w: number }>(
      `SELECT date_bin($2::interval, v.ts, 'epoch') AS t,
              (array_agg(v.b ORDER BY v.ts DESC))[1] AS b,
              (array_agg(v.h ORDER BY v.ts DESC))[1] AS h,
              (array_agg(v.w ORDER BY v.ts DESC))[1] AS w
       FROM oracle_values v JOIN blokes bl ON bl.id = v.bloke_id
       WHERE bl.ticker = $1 AND v.ts > now() - $3::interval
       GROUP BY 1 ORDER BY 1`,
      [ticker.toUpperCase(), r.bucket, r.interval],
    );
    return {
      data: rows.rows.map((x) => ({ t: x.t.toISOString(), b: x.b, h: x.h, w: x.w })),
      meta: { ...meta({ index: "indexed" }), leg: q.leg, bucket: r.bucket },
    };
  });

  /**
   * Per-source z-scores and effective weights from index-compute's latest tick (P3). `mode` says
   * whether the Bloke is priced from real signals or still follows the synthetic walk (A16).
   */
  app.get("/v1/blokes/:ticker/signals", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10) }).parse(req.params);
    const r = await ctx.db.query<{ id: number; z: Record<string, number>; degraded: string[]; stopped: boolean; ts: Date; params: { blokes?: Record<string, { mode: string; weights?: Record<string, number> }> } }>(
      `SELECT b.id, t.z, t.degraded::text[] AS degraded, t.stopped, t.ts, p.params
         FROM index_ticks t JOIN blokes b ON b.id = t.bloke_id JOIN index_params p ON p.version = t.params_version
        WHERE b.ticker = $1 ORDER BY t.ts DESC LIMIT 1`,
      [ticker.toUpperCase()],
    );
    const row = r.rows[0];
    const mode = row?.params.blokes?.[String(row.id)];
    const weights = mode?.weights ?? {};
    const data = Object.entries(weights).map(([source, weight]) => ({
      source,
      z: row!.z[source] ?? 0,
      weight,
      degraded: row!.degraded.includes(source),
    }));
    return {
      data,
      meta: { ...meta({ signals: "computed" }), available: row !== undefined, mode: mode?.mode ?? null, stopped: row?.stopped ?? null, at: row?.ts.toISOString() ?? null },
    };
  });

  app.get("/v1/markets/:id/trades", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().min(0) }).parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = await ctx.db.query<{ kind: "fill" | "close"; lot_id: string; side: number; price: string; collateral: string | null; payout: string | null; at: Date; tx: Buffer }>(
      `(SELECT 'fill' AS kind, l.id::text AS lot_id, l.side, l.entry_price::text AS price, l.collateral::text AS collateral, NULL AS payout, l.opened_at AS at, l.open_tx AS tx
          FROM lots l WHERE l.market_id = $1 ORDER BY l.opened_at DESC LIMIT $2)
       UNION ALL
       (SELECT 'close', l.id::text, l.side, c.exit_price::text, l.collateral::text, c.payout::text, c.closed_at, c.tx_hash
          FROM closes c JOIN lots l ON l.id = c.lot_id WHERE l.market_id = $1 ORDER BY c.closed_at DESC LIMIT $2)
       ORDER BY at DESC LIMIT $2`,
      [id, limit],
    );
    const data: Trade[] = rows.rows.map((r) => ({
      kind: r.kind,
      lotId: r.lot_id,
      side: r.side,
      price: r.price,
      ...(r.collateral && { collateral: r.collateral }),
      ...(r.payout && { payout: r.payout }),
      at: r.at.toISOString(),
      txHash: bufToHex(r.tx)!,
    }));
    return { data, meta: meta({ trades: "indexed" }) };
  });

  app.get("/v1/pool", async () => {
    const data = await ctx.cache.get("pool", 1_000, () => poolView(ctx));
    return { data, meta: meta({ pool: "on-chain" }) };
  });

  app.get("/v1/epochs", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(24) }).parse(req.query);
    const r = await ctx.db.query(`SELECT * FROM epochs ORDER BY n DESC LIMIT $1`, [limit]);
    const data: EpochRow[] = r.rows.map((x) => ({
      n: String(x.n),
      g: String(x.g),
      fee: String(x.fee),
      dReserve: String(x.d_reserve),
      dTreasury: String(x.d_treasury),
      floorAccrual: String(x.floor_accrual),
      dEdge: String(x.d_edge),
      skinAbsorbed: String(x.skin_absorbed),
      impairment: String(x.impairment),
      settledAt: x.settled_at.toISOString(),
    }));
    return { data, meta: meta({ epochs: "indexed" }) };
  });

  app.get("/v1/wallets/:addr", async (req) => {
    const { addr } = z.object({ addr: z.string() }).parse(req.params);
    if (!isAddress(addr)) throw badRequest("bad_address", "Not an address.");
    const wallet = getAddress(addr);
    const w = hexToBuf(wallet);
    const [chainBits, lots, orders, rep] = await Promise.all([
      Promise.all([
        ctx.pub.readContract({ address: ctx.a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [wallet] }),
        ctx.pub.getBalance({ address: wallet }),
        ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "claimable", args: [wallet] }),
        ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "iou", args: [wallet] }),
        ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "pendingCount", args: [wallet] }),
      ]),
      ctx.db.query(
        `SELECT l.id::text AS lot_id, l.market_id, l.side, l.status, l.collateral::text, l.units::text, l.entry_price::text, l.group_id::text, l.opened_at,
                b.id AS bloke_id, b.ticker,
                c.exit_price::text, c.price_pnl::text, c.funding_pnl::text, c.fee::text, c.payout::text, c.closed_at
         FROM lots l JOIN blokes b ON b.id = l.market_id / 3 LEFT JOIN closes c ON c.lot_id = l.id
         WHERE l.owner = $1 ORDER BY l.opened_at DESC LIMIT 200`,
        [w],
      ),
      ctx.db.query(
        `SELECT id::text, market_id, side, kind, collateral::text, status, reject_reason, requested_at, final_at
         FROM orders WHERE owner = $1 ORDER BY requested_at DESC LIMIT 50`,
        [w],
      ),
      ctx.db.query<{ season: number; total: number }>(`SELECT season, total FROM rep_scores WHERE wallet = $1 ORDER BY season DESC, computed_at DESC LIMIT 1`, [w]),
    ]);
    const [tusdc, mon, claimable, iou, pending] = chainBits;

    const lotRows: Lot[] = lots.rows.map((r) => ({
      lotId: r.lot_id,
      marketId: r.market_id,
      blokeId: r.bloke_id,
      ticker: r.ticker,
      leg: LEGS[r.market_id % 3]!,
      side: r.side,
      status: r.status,
      collateral: r.collateral,
      units: r.units,
      entryPrice: r.entry_price,
      groupId: r.group_id,
      openedAt: r.opened_at.toISOString(),
      ...(r.closed_at && {
        close: { exitPrice: r.exit_price, pricePnl: r.price_pnl, fundingPnl: r.funding_pnl, fee: r.fee, payout: r.payout, closedAt: r.closed_at.toISOString() },
      }),
    }));
    // Live equity for open lots straight from the engine (PRD F2: "live PnL and funding").
    const open = lotRows.filter((l) => l.status === "open");
    if (open.length) {
      const views = await Promise.all(
        open.map((l) => ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "lotView", args: [BigInt(l.lotId)] })),
      );
      open.forEach((l, i) => {
        const [equity, pricePnl, fundingPnl, exhausted] = views[i]!;
        Object.assign(l, { equity: equity.toString(), pricePnl: pricePnl.toString(), fundingPnl: fundingPnl.toString(), exhausted });
      });
    }
    const data: WalletView = {
      address: wallet,
      tusdc: tusdc.toString(),
      mon: mon.toString(),
      claimable: claimable.toString(),
      iou: iou.toString(),
      pendingCount: Number(pending),
      lots: lotRows,
      orders: orders.rows.map(
        (r): Order => ({
          orderId: r.id,
          marketId: r.market_id,
          side: r.side,
          kind: r.kind,
          collateral: r.collateral,
          status: r.status,
          rejectReason: r.reject_reason,
          requestedAt: r.requested_at.toISOString(),
          finalAt: r.final_at?.toISOString() ?? null,
        }),
      ),
      rep: rep.rows[0] ? { season: rep.rows[0].season, total: rep.rows[0].total } : null,
      decks: await deckPosition(ctx, wallet),
      profiles: await profilesOf(ctx, w),
    };
    return { data, meta: meta({ balances: "on-chain", lots: "indexed", equity: "on-chain", orders: "indexed", rep: "computed" }) };
  });

  app.get("/v1/rep", async (req) => {
    const q = z.object({ season: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r = await ctx.db.query<{ wallet: Buffer; total: number }>(
      `SELECT DISTINCT ON (wallet) wallet, total FROM rep_scores WHERE season = $1 ORDER BY wallet, computed_at DESC`,
      [q.season],
    );
    const ranked = r.rows.sort((x, y) => y.total - x.total).slice(0, q.limit);
    return { data: ranked.map((x, i) => ({ wallet: bufToHex(x.wallet) as Address, total: x.total, rank: i + 1 })), meta: meta({ rep: "computed" }) };
  });

  app.get("/v1/status", async () => {
    const blokes = (await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes ORDER BY id`)).rows;
    const [head, latest, lastSeq, paused, cursor] = await Promise.all([
      headBlock(ctx),
      blokes.length ? oracleLatest(ctx, blokes.map((b) => b.id)) : Promise.resolve(new Map()),
      ctx.pub.readContract({ address: ctx.a.oracle, abi: humanIndexOracleAbi, functionName: "lastSeq" }),
      ctx.pub.readContract({ address: ctx.a.oracle, abi: humanIndexOracleAbi, functionName: "paused" }),
      ctx.db.query<{ block_number: string }>(`SELECT block_number FROM indexer_cursor WHERE chain_id = $1`, [ctx.a.chainId]),
    ]);
    const now = Date.now();
    const ages = blokes.map((b) => {
      const l = latest.get(b.id);
      return { id: b.id, ticker: b.ticker, pushAgeMs: l && l.tsMs !== "0" ? now - Number(l.tsMs) : null, fresh: !!l?.fresh };
    });
    const known = ages.map((x) => x.pushAgeMs).filter((x): x is number => x !== null);
    const idxBlock = cursor.rows[0]?.block_number ?? null;
    const { staging, startBlock: _s, chainId: _c, ...addresses } = ctx.a;
    const data: StatusView = {
      chainId: ctx.a.chainId,
      staging,
      addresses: addresses as unknown as Record<string, Address>,
      oracle: { lastSeq: lastSeq.toString(), lastPushAgeMs: known.length ? Math.min(...known) : null, paused },
      blokes: ages,
      indexer: { block: idxBlock, lagBlocks: idxBlock ? Number(head - BigInt(idxBlock)) : null },
      headBlock: head.toString(),
    };
    return { data, meta: meta({ oracle: "on-chain", indexer: "indexed" }, head) };
  });
}

/**
 * Graduation checklist from chain state (PRD §10.1). Checks whose source phase hasn't shipped report
 * `available: false` so the UI can show them greyed out rather than failing.
 */
const CHECK_NAMES = [
  "Profile claimed, not frozen",
  "Verified output source",
  "Human Capital Score (window average)",
  "Work over hype",
  "Open interest (time-weighted)",
  "Real traders (identity-linked)",
  "Skin held",
  "No abuse flags, not graduated",
] as const;

/** PRD §10.1 checklist straight from GraduationLauncher.checks, with the attested trader count. */
async function graduationChecks(ctx: Ctx, blokeId: number) {
  const [reg, avgDays] = await Promise.all([registryBloke(ctx, blokeId), configValue(ctx, "GRAD_AVG_DAYS")]);
  const profile = Number(avgDays) === 14 ? ("mainnet-intent" as const) : Number(avgDays) === 5 ? ("event" as const) : ("custom" as const);
  if (!ctx.a.launcher) return { profile, checks: CHECK_NAMES.map((name) => ({ name, pass: false, value: "—", threshold: "—", available: false })) };
  const claimed = reg.wallet === "0x0000000000000000000000000000000000000000" ? null : reg.wallet;
  const traders = claimed ? await ctx.cache.get(`traders:${blokeId}`, 60_000, () => grad.traderCount(ctx, blokeId, claimed)) : 0;
  const [pass, value, threshold] = await ctx.cache.get(`checks:${blokeId}`, 2_000, () => grad.launcherChecks(ctx, blokeId, traders));
  const v = (i: number) => value[i]!;
  const t = (i: number) => threshold[i]!;
  const usdc = (x: bigint) => `${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} tUSDC`;
  const days = (x: bigint) => `${(Number(x) / 86_400).toFixed(1)} d`;
  const fmt: [string, string][] = [
    [claimed ? (reg.claimFrozen ? "frozen" : (["none", "shadow", "claimed", "delist pending", "delisted", "graduated"][reg.status] ?? "?")) : "unclaimed", "claimed, live"],
    [`0b${Number(v(1)).toString(2)}`, "≥ 1 source"],
    [(Number(v(2)) / 1e4).toFixed(1), `≥ ${(Number(t(2)) / 1e4).toFixed(0)} over ${avgDays} d`],
    [`W ${(Number(v(3)) / 1e4).toFixed(1)}`, `≥ H ${(Number(t(3)) / 1e4).toFixed(1)}`],
    [usdc(v(4)), `≥ ${usdc(t(4))}`],
    [String(v(5)), `≥ ${t(5)}`],
    [days(v(6)), `≥ ${days(t(6))}`],
    [v(7) === 0n ? "none" : `flag ${v(7)}`, "none"],
  ];
  const checks: GraduationCheck[] = CHECK_NAMES.map((name, i) => ({ name, pass: pass[i]!, value: fmt[i]![0], threshold: fmt[i]![1], available: true }));
  return { profile, checks };
}

const SERIES_STATE = ["none", "subscribing", "active", "matured"] as const;

async function seriesView(ctx: Ctx, id: number): Promise<FloorSeriesView> {
  const s = await ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "series", args: [BigInt(id)] });
  return {
    id,
    rateBps: s.rateBps,
    start: new Date(Number(s.start) * 1000).toISOString(),
    end: new Date(Number(s.end) * 1000).toISOString(),
    state: SERIES_STATE[s.state] as FloorSeriesView["state"],
    subscribed: s.subscribed.toString(),
    principal: s.principal.toString(),
    value: s.value.toString(),
    token: s.token,
  };
}

async function poolView(ctx: Ctx): Promise<PoolView> {
  const p = ctx.a.pool;
  const [nav, capBase, active, open, edgeToken, params, globalReduceOnly, globalNetAbs, hypeFamily] = await Promise.all([
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "nav" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "capBase" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "activeSeries" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "openSeries" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "edgeShares" }),
    ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "params" }),
    ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "globalReduceOnly" }),
    ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "globalNetAbs" }),
    ctx.pub.readContract({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "hypeFamily" }),
  ]);
  const [F, E, R, T, subBps, paused, credit, epoch, endsAt] = nav;
  const [totalShares, oneShare] = await Promise.all([
    ctx.pub.readContract({ address: edgeToken, abi: poolShareAbi, functionName: "totalSupply" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "edgeValue", args: [10n ** 12n] }),
  ]);
  const pr = params as unknown as { netCapMarketBps: number; netCapGlobalBps: number; netCapFamilyBps: number };
  return {
    phase: "P2-waterfall",
    capBase: capBase.toString(),
    floor: {
      value: F.toString(),
      active: active > 0n ? await seriesView(ctx, Number(active) - 1) : null,
      open: open > 0n ? await seriesView(ctx, Number(open) - 1) : null,
      paused,
    },
    edge: { nav: E.toString(), totalShares: totalShares.toString(), sharePrice: oneShare.toString(), token: edgeToken },
    reserve: R.toString(),
    treasury: T.toString(),
    subordinationBps: Number(subBps),
    creditEvent: credit,
    epoch: epoch.toString(),
    epochEndsAt: new Date(Number(endsAt) * 1000).toISOString(),
    globalReduceOnly,
    globalNetAbs: globalNetAbs.toString(),
    hypeFamily: hypeFamily.toString(),
    caps: { netCapMarketBps: Number(pr.netCapMarketBps), netCapGlobalBps: Number(pr.netCapGlobalBps), netCapFamilyBps: Number(pr.netCapFamilyBps) },
  };
}

/** A wallet's Edge shares, Floor tokens, queued Edge requests and Floor subscriptions. */
async function deckPosition(ctx: Ctx, wallet: Address): Promise<DeckPosition> {
  const p = ctx.a.pool;
  const [edgeToken, epoch, count] = await Promise.all([
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "edgeShares" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "epoch" }),
    ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "seriesCount" }),
  ]);
  const shares = await ctx.pub.readContract({ address: edgeToken, abi: poolShareAbi, functionName: "balanceOf", args: [wallet] });
  const value = await ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "edgeValue", args: [shares] });
  // Requests from the last few epochs that may still be claimable.
  const pendingEdge: DeckPosition["pendingEdge"] = [];
  for (let e = epoch; e >= 0n && e + 24n > epoch; e--) {
    const [dep, red, bucket] = await Promise.all([
      ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "depositOf", args: [e, wallet] }),
      ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "redeemOf", args: [e, wallet] }),
      ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "buckets", args: [e] }),
    ]);
    if (dep > 0n || red > 0n) pendingEdge.push({ epoch: e.toString(), deposit: dep.toString(), redeemShares: red.toString(), processed: bucket[5] });
    if (e === 0n) break;
  }
  const floor: DeckPosition["floor"] = [];
  const subscriptions: DeckPosition["subscriptions"] = [];
  for (let i = 0n; i < count; i++) {
    const s = await ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "series", args: [i] });
    const [bal, sub] = await Promise.all([
      ctx.pub.readContract({ address: s.token, abi: poolShareAbi, functionName: "balanceOf", args: [wallet] }),
      ctx.pub.readContract({ address: p, abi: blokePoolAbi, functionName: "subscriptionOf", args: [i, wallet] }),
    ]);
    if (bal > 0n) floor.push({ seriesId: Number(i), shares: bal.toString(), state: SERIES_STATE[s.state] ?? "none" });
    if (sub > 0n) subscriptions.push({ seriesId: Number(i), amount: sub.toString(), claimable: s.state >= 2 });
  }
  return { edgeShares: shares.toString(), edgeValue: value.toString(), floor, pendingEdge, subscriptions };
}

async function profilesOf(ctx: Ctx, w: Buffer) {
  const rows = (await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes WHERE claimed_wallet = $1`, [w])).rows;
  return Promise.all(
    rows.map(async (r) => {
      const [skin, has, since] = await Promise.all([
        ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "skin", args: [r.id] }),
        ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "hasSkin", args: [r.id] }),
        ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "skinSince", args: [r.id] }),
      ]);
      return { blokeId: r.id, ticker: r.ticker, skin: skin.toString(), hasSkin: has, skinSince: since > 0n ? new Date(Number(since) * 1000).toISOString() : null };
    }),
  );
}
