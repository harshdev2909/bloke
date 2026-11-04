import type pg from "pg";
import type { SourceId } from "@bloke/index-core";
import type { SignalPoint } from "./engine.js";
import type { CollectedEvent, SourceAccount } from "./collectors/types.js";

export interface BlokeRow {
  id: number;
  status: string;
}

export async function activeBlokes(db: pg.Pool): Promise<BlokeRow[]> {
  return (await db.query<BlokeRow>(`SELECT id, status::text FROM blokes WHERE status IN ('shadow', 'live', 'delist_pending') ORDER BY id`)).rows;
}

export async function sourceAccounts(db: pg.Pool): Promise<SourceAccount[]> {
  const r = await db.query<{ bloke_id: number; kind: SourceId; external_id: string; handle: string | null; verified: boolean }>(
    `SELECT s.bloke_id, s.kind::text AS kind, s.external_id, s.handle, s.verified
       FROM bloke_sources s JOIN blokes b ON b.id = s.bloke_id
      WHERE s.enabled AND b.status IN ('shadow', 'live', 'delist_pending')`,
  );
  return r.rows.map((x) => ({ blokeId: x.bloke_id, kind: x.kind, externalId: x.external_id, handle: x.handle, verified: x.verified }));
}

export interface CollectorRow {
  state: Record<string, unknown>;
  okAtMs: number | null;
}

export async function collectorStates(db: pg.Pool): Promise<Map<string, CollectorRow>> {
  const r = await db.query<{ bloke_id: number; source: string; external_id: string; state: Record<string, unknown>; ok_at: Date | null }>(
    `SELECT bloke_id, source::text AS source, external_id, state, ok_at FROM collector_state`,
  );
  return new Map(r.rows.map((x) => [accountKey({ blokeId: x.bloke_id, kind: x.source as SourceId, externalId: x.external_id }), { state: x.state, okAtMs: x.ok_at?.getTime() ?? null }]));
}

export const accountKey = (a: Pick<SourceAccount, "blokeId" | "kind" | "externalId">) => `${a.blokeId}:${a.kind}:${a.externalId}`;

export async function saveEvents(db: pg.Pool, a: SourceAccount, events: readonly CollectedEvent[], mode: "insert" | "upsert"): Promise<number> {
  if (!events.length) return 0;
  const conflict = mode === "upsert" ? "DO UPDATE SET value = EXCLUDED.value, quality = EXCLUDED.quality" : "DO NOTHING";
  const r = await db.query(
    `INSERT INTO signal_events (bloke_id, source, external_ref, ts, value, quality, filtered_reason)
     SELECT $1, $2::source_kind, e.ref, to_timestamp(e.t / 1000.0), e.v, e.q, e.f
       FROM jsonb_to_recordset($3::jsonb) AS e(ref text, t double precision, v double precision, q double precision, f text)
     ON CONFLICT (bloke_id, source, external_ref) ${conflict}`,
    [a.blokeId, a.kind, JSON.stringify(events.map((e) => ({ ref: e.ref, t: e.tMs, v: e.value, q: e.quality ?? null, f: e.filtered ?? null })))],
  );
  return r.rowCount ?? 0;
}

export async function markOk(db: pg.Pool, a: SourceAccount, state: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO collector_state (bloke_id, source, external_id, state, ok_at, error) VALUES ($1, $2, $3, $4, now(), NULL)
     ON CONFLICT (bloke_id, source, external_id) DO UPDATE SET state = EXCLUDED.state, ok_at = now(), error = NULL`,
    [a.blokeId, a.kind, a.externalId, JSON.stringify(state)],
  );
}

export async function markError(db: pg.Pool, a: SourceAccount, error: string): Promise<void> {
  await db.query(
    `INSERT INTO collector_state (bloke_id, source, external_id, error, error_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (bloke_id, source, external_id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`,
    [a.blokeId, a.kind, a.externalId, error.slice(0, 500)],
  );
}

/** Counted events per (Bloke, source) since `sinceMs`. */
export async function points(db: pg.Pool, sinceMs: number): Promise<Map<string, SignalPoint[]>> {
  const r = await db.query<{ bloke_id: number; source: string; t: number; value: number }>(
    `SELECT bloke_id, source::text AS source, extract(epoch FROM ts) * 1000 AS t, value
       FROM signal_events WHERE filtered_reason IS NULL AND ts >= to_timestamp($1 / 1000.0)`,
    [sinceMs],
  );
  const out = new Map<string, SignalPoint[]>();
  for (const x of r.rows) {
    const k = `${x.bloke_id}:${x.source}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push({ tMs: Number(x.t), value: x.value });
  }
  return out;
}

export async function saveParams(db: pg.Pool, version: `0x${string}`, doc: unknown): Promise<void> {
  await db.query(`INSERT INTO index_params (version, params, active_from) VALUES ($1, $2, now()) ON CONFLICT (version) DO NOTHING`, [
    Buffer.from(version.slice(2), "hex"),
    JSON.stringify(doc),
  ]);
}

export interface TickRow {
  blokeId: number;
  b: number;
  h: number;
  w: number;
  z: Record<string, number>;
  degraded: string[];
  stopped: boolean;
}

export async function saveTicks(db: pg.Pool, tsMs: number, version: `0x${string}`, ticks: readonly TickRow[]): Promise<void> {
  if (!ticks.length) return;
  await db.query(
    `INSERT INTO index_ticks (ts, bloke_id, b, h, w, z, degraded, stopped, params_version)
     SELECT to_timestamp($1 / 1000.0), t.id, t.b, t.h, t.w, t.z, t.d::source_kind[], t.s, $2
       FROM jsonb_to_recordset($3::jsonb) AS t(id integer, b integer, h integer, w integer, z jsonb, d text[], s boolean)
     ON CONFLICT (bloke_id, ts) DO NOTHING`,
    [tsMs, Buffer.from(version.slice(2), "hex"), JSON.stringify(ticks.map((t) => ({ id: t.blokeId, b: t.b, h: t.h, w: t.w, z: t.z, d: t.degraded, s: t.stopped })))],
  );
}

/** Hourly published aggregates (PRD §4.5): counted events per Bloke, source and hour. */
export async function rollupHourly(db: pg.Pool, sinceMs: number): Promise<void> {
  await db.query(
    `INSERT INTO signal_hourly (bloke_id, source, hour, count, value)
     SELECT bloke_id, source, date_trunc('hour', ts), count(*), sum(value)
       FROM signal_events WHERE filtered_reason IS NULL AND ts >= to_timestamp($1 / 1000.0)
      GROUP BY 1, 2, 3
     ON CONFLICT (bloke_id, source, hour) DO UPDATE SET count = EXCLUDED.count, value = EXCLUDED.value`,
    [sinceMs],
  );
}
