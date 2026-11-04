import { type IndexParams, type Leg, type SourceId, SOURCES, legWeights } from "./params.js";
import { type Baseline, degradedZ, squash, toScaled, zScore } from "./math.js";

export interface SourceState {
  /** Current decayed level x_s(now); undefined when the source has never reported. */
  x: number | undefined;
  baseline: Baseline;
  /** Ownership-verified (WORK only; HYPE always uses 1.0). */
  verified: boolean;
  /** Set when the source's circuit breaker is open. */
  degradedSinceMs?: number;
  /** Last healthy z, used while degraded. */
  lastZ?: number;
}

export interface IndexResult {
  /** Index values in index points (0–200). */
  b: number;
  h: number;
  w: number;
  /** Scaled for the oracle (×1e4). */
  scaled: { b: number; h: number; w: number };
  z: Partial<Record<SourceId, number>>;
  degraded: SourceId[];
  /** True when the Bloke must not be pushed (≥ maxDegradedPerLeg degraded in a leg). */
  stopped: boolean;
  stopReason?: string;
}

/**
 * Pure function from source states to the three index values (PRD §4.2). Deterministic given
 * (states, params, nowMs), so any push can be recomputed from published aggregates.
 */
export function computeIndex(
  states: Partial<Record<SourceId, SourceState>>,
  params: IndexParams,
  nowMs: number,
): IndexResult {
  const z: Partial<Record<SourceId, number>> = {};
  const degraded: SourceId[] = [];

  for (const id of SOURCES) {
    if (!params.sources[id].enabled) continue;
    const s = states[id];
    if (!s) {
      // Never reported: treat as degraded from the start with z = 0.
      degraded.push(id);
      z[id] = 0;
      continue;
    }
    if (s.degradedSinceMs !== undefined || s.x === undefined) {
      degraded.push(id);
      z[id] = degradedZ(s.lastZ ?? 0, s.degradedSinceMs ?? nowMs, nowMs, params.degradedHoldMinutes, params.degradedHalfLifeHours);
      continue;
    }
    z[id] = zScore(s.x, s.baseline, params.zClamp, params.sigmaFloorAbs, params.sigmaFloorRel);
  }

  const legSum = (leg: Leg): number => {
    let sum = 0;
    for (const [id, weight] of legWeights(params, leg)) {
      const credibility = leg === "work" && !states[id]?.verified ? params.unverifiedCredibility : 1;
      sum += weight * credibility * (z[id] ?? 0);
    }
    return sum;
  };

  let stopReason: string | undefined;
  for (const leg of ["hype", "work"] as const) {
    const enabled = [...legWeights(params, leg).keys()];
    const bad = enabled.filter((id) => degraded.includes(id));
    if (bad.length >= Math.min(params.maxDegradedPerLeg, enabled.length)) {
      stopReason = `${leg}: degraded ${bad.join(",")}`;
    }
  }

  const H = squash(legSum("hype"));
  const W = squash(legSum("work"));
  const b = 100 * (params.alpha * H + (1 - params.alpha) * W);
  const h = 100 * H;
  const w = 100 * W;
  return {
    b,
    h,
    w,
    scaled: { b: toScaled(b), h: toScaled(h), w: toScaled(w) },
    z,
    degraded,
    stopped: stopReason !== undefined,
    ...(stopReason !== undefined && { stopReason }),
  };
}
