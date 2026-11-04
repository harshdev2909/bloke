/** Core index math (PRD §4.2). All times are milliseconds since epoch. */

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Exponentially decayed activity level x_s(t) = Σ v_i e^{-(t - t_i)/τ}, kept incrementally. */
export interface DecayedLevel {
  level: number;
  tMs: number;
}

export function decayTo(d: DecayedLevel, tMs: number, tauHours: number): DecayedLevel {
  if (tMs <= d.tMs) return d;
  return { level: d.level * Math.exp(-(tMs - d.tMs) / (tauHours * HOUR_MS)), tMs };
}

/** Adds an event. Late events (t < d.tMs) are decayed back to the level's time, so order doesn't matter. */
export function addEvent(d: DecayedLevel, value: number, tMs: number, tauHours: number): DecayedLevel {
  if (tMs >= d.tMs) {
    const at = decayTo(d, tMs, tauHours);
    return { level: at.level + value, tMs };
  }
  return { level: d.level + value * Math.exp(-(d.tMs - tMs) / (tauHours * HOUR_MS)), tMs: d.tMs };
}

export interface Baseline {
  mu: number;
  sigma: number;
  nDays: number;
}

/**
 * Mean and standard deviation of daily 00:00 UTC samples over the prior `windowDays`, excluding
 * the last 24 hours. `samples` maps UTC day number → x_s sampled at that day's 00:00.
 */
export function baselineFromSamples(samples: ReadonlyMap<number, number>, nowMs: number, windowDays: number): Baseline {
  const cutoffDay = Math.floor((nowMs - DAY_MS) / DAY_MS); // newest sample allowed: at least 24h old
  const xs: number[] = [];
  for (let day = cutoffDay; day > cutoffDay - windowDays; day--) {
    const v = samples.get(day);
    if (v !== undefined && day * DAY_MS <= nowMs - DAY_MS) xs.push(v);
  }
  if (xs.length === 0) return { mu: 0, sigma: 0, nDays: 0 };
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length;
  return { mu, sigma: Math.sqrt(variance), nDays: xs.length };
}

/** Short-history shrinkage toward the launch-cohort prior (PRD §4.4). */
export function shrinkToCohort(own: Baseline, cohort: Baseline, priorDays: number): Baseline {
  if (own.nDays >= priorDays) return own;
  const n = own.nDays;
  return {
    mu: (n * own.mu + priorDays * cohort.mu) / (n + priorDays),
    sigma: (n * own.sigma + priorDays * cohort.sigma) / (n + priorDays),
    nDays: n,
  };
}

export function zScore(x: number, b: Baseline, clamp: number, floorAbs: number, floorRel: number): number {
  const sigma = Math.max(b.sigma, Math.max(floorAbs, floorRel * b.mu));
  const z = (x - b.mu) / sigma;
  return Math.max(-clamp, Math.min(clamp, z));
}

/** sq(z) = 2 / (1 + e^{-z}), mapping ℝ → (0, 2) with sq(0) = 1. */
export function squash(z: number): number {
  return 2 / (1 + Math.exp(-z));
}

/**
 * A degraded source holds its last z for `holdMinutes`, then decays toward 0 with the given
 * half-life (PRD §4.4).
 */
export function degradedZ(lastZ: number, degradedSinceMs: number, nowMs: number, holdMinutes: number, halfLifeHours: number): number {
  const elapsed = nowMs - degradedSinceMs - holdMinutes * 60_000;
  if (elapsed <= 0) return lastZ;
  return lastZ * 2 ** (-elapsed / (halfLifeHours * HOUR_MS));
}

/** Index value as the oracle's uint32 scaled 1e4 (100.0 → 1_000_000). */
export function toScaled(index: number): number {
  return Math.round(index * 1e4);
}
