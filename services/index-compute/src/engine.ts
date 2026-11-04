import {
  type Baseline,
  DAY_MS,
  type IndexParams,
  type IndexResult,
  type SourceId,
  type SourceState,
  SOURCES,
  baselineFromSamples,
  canonicalJson,
  computable,
  computeIndex,
  legWeights,
  paramsForSources,
  shrinkToCohort,
} from "@bloke/index-core";
import { keccak256, toBytes } from "viem";

/** One counted signal event (filtered events never reach the engine). */
export interface SignalPoint {
  tMs: number;
  value: number;
}

/** Collector health for one (Bloke, source): degraded when it hasn't succeeded recently. */
export interface Health {
  okAtMs: number | null;
  /** How long without a successful poll before the source counts as degraded. */
  staleMs: number;
}

export interface BlokeInput {
  blokeId: number;
  /** Sources the Bloke has an account on that a collector is running for. */
  sources: Map<SourceId, { verified: boolean; health: Health; points: SignalPoint[] }>;
}

const HOUR_MS = 3_600_000;

/** x_s(t) = Σ v_i e^{-(t - t_i)/τ} over events at or before t. */
export function levelAt(points: readonly SignalPoint[], tMs: number, tauHours: number): number {
  let x = 0;
  for (const p of points) if (p.tMs <= tMs) x += p.value * Math.exp(-(tMs - p.tMs) / (tauHours * HOUR_MS));
  return x;
}

/**
 * Daily 00:00 UTC samples of the decayed level, for the baseline. Only days after the first event
 * count: before a source existed there is no history, not a history of zeros.
 */
export function dailySamples(points: readonly SignalPoint[], nowMs: number, days: number, tauHours: number): Map<number, number> {
  const out = new Map<number, number>();
  if (!points.length) return out;
  const first = Math.min(...points.map((p) => p.tMs));
  const today = Math.floor(nowMs / DAY_MS);
  for (let d = today; d > today - days - 1; d--) {
    if (d * DAY_MS < first) break;
    out.set(d, levelAt(points, d * DAY_MS, tauHours));
  }
  return out;
}

/**
 * Launch-cohort prior for a source: the mean of the Blokes' own baselines (PRD §4.4). Null when no
 * Bloke has 3 days of history yet; the caller then measures a history-less source against zero
 * activity, so it reads neutral while idle and positive once something happens.
 */
export function cohortPrior(own: readonly Baseline[]): Baseline | null {
  const usable = own.filter((b) => b.nDays >= 3);
  if (!usable.length) return null;
  return {
    mu: usable.reduce((a, b) => a + b.mu, 0) / usable.length,
    sigma: usable.reduce((a, b) => a + b.sigma, 0) / usable.length,
    nDays: 0,
  };
}

export function sourceState(
  input: { verified: boolean; health: Health; points: SignalPoint[] },
  id: SourceId,
  params: IndexParams,
  cohort: Baseline | null,
  nowMs: number,
  lastZ?: number,
): { state: SourceState; own: Baseline } {
  const tau = params.sources[id].tauHours;
  const own = baselineFromSamples(dailySamples(input.points, nowMs, params.baselineDays, tau), nowMs, params.baselineDays);
  // No cohort yet: with no history of its own the source is measured against zero activity (idle
  // reads neutral, new activity reads positive); with some history it stands on that history alone.
  const prior = cohort ?? (own.nDays === 0 ? { mu: 0, sigma: 0, nDays: 0 } : own);
  const stale = input.health.okAtMs === null || nowMs - input.health.okAtMs > input.health.staleMs;
  const state: SourceState = {
    x: input.health.okAtMs === null ? undefined : levelAt(input.points, nowMs, tau),
    baseline: shrinkToCohort(own, prior, params.cohortPriorDays),
    verified: input.verified,
    ...(stale && { degradedSinceMs: (input.health.okAtMs ?? nowMs) + (input.health.okAtMs === null ? 0 : input.health.staleMs) }),
    ...(lastZ !== undefined && { lastZ }),
  };
  return { state, own };
}

export type BlokeMode = { mode: "signals"; sources: SourceId[]; weights: Record<SourceId, number> } | { mode: "synthetic" };

/** The published parameter document: global params plus each Bloke's mode (amendment A16). */
export function paramsDocument(params: IndexParams, modes: ReadonlyMap<number, BlokeMode>) {
  return { params, blokes: Object.fromEntries([...modes].sort(([a], [b]) => a - b)) };
}

export function documentVersion(doc: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalJson(doc)));
}

/** Mode for a Bloke: real signals when both legs have a source, otherwise the synthetic walk. */
export function modeFor(params: IndexParams, available: ReadonlySet<SourceId>): { p: IndexParams; mode: BlokeMode } {
  const p = paramsForSources(params, available);
  if (!computable(p)) return { p, mode: { mode: "synthetic" } };
  const weights = {} as Record<SourceId, number>;
  for (const leg of ["hype", "work"] as const) for (const [id, w] of legWeights(p, leg)) weights[id] = Number(w.toFixed(6));
  return { p, mode: { mode: "signals", sources: SOURCES.filter((s) => available.has(s)), weights } };
}

/**
 * Computes every signals-mode Bloke. Cohort priors are taken across all Blokes per source before
 * any Bloke is computed, so the order of Blokes doesn't change anyone's value.
 */
export function computeAll(
  inputs: readonly BlokeInput[],
  params: IndexParams,
  nowMs: number,
  lastZ: ReadonlyMap<number, Partial<Record<SourceId, number>>> = new Map(),
): Map<number, IndexResult> {
  const own = new Map<SourceId, Baseline[]>();
  for (const b of inputs)
    for (const [id, s] of b.sources) {
      const tau = params.sources[id].tauHours;
      const bl = baselineFromSamples(dailySamples(s.points, nowMs, params.baselineDays, tau), nowMs, params.baselineDays);
      (own.get(id) ?? own.set(id, []).get(id)!).push(bl);
    }
  const out = new Map<number, IndexResult>();
  for (const b of inputs) {
    const { p, mode } = modeFor(params, new Set(b.sources.keys()));
    if (mode.mode !== "signals") continue;
    const states: Partial<Record<SourceId, SourceState>> = {};
    for (const [id, s] of b.sources) states[id] = sourceState(s, id, p, cohortPrior(own.get(id) ?? []), nowMs, lastZ.get(b.blokeId)?.[id]).state;
    out.set(b.blokeId, computeIndex(states, p, nowMs));
  }
  return out;
}
