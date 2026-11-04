import { keccak256, toBytes } from "viem";

export type Leg = "hype" | "work";
export type SourceId = "x" | "reddit" | "search" | "hn" | "commits" | "releases" | "onchain";

export interface SourceParams {
  leg: Leg;
  weight: number;
  /** Decay time constant in hours. */
  tauHours: number;
  /**
   * Optional sources may be disabled (amendment A11: Reddit needs manual approval, the Trends API is
   * an invite-only alpha). Disabled sources drop out and the leg's weights are renormalised.
   */
  enabled: boolean;
}

export interface IndexParams {
  alpha: number;
  sources: Record<SourceId, SourceParams>;
  baselineDays: number;
  zClamp: number;
  unverifiedCredibility: number;
  cohortPriorDays: number;
  sigmaFloorAbs: number;
  sigmaFloorRel: number;
  degradedHoldMinutes: number;
  degradedHalfLifeHours: number;
  maxDegradedPerLeg: number;
}

export const SOURCES: readonly SourceId[] = ["x", "reddit", "search", "hn", "commits", "releases", "onchain"];
export const HYPE_SOURCES: readonly SourceId[] = ["x", "reddit", "search", "hn"];
export const WORK_SOURCES: readonly SourceId[] = ["commits", "releases", "onchain"];

export const DEFAULT_PARAMS: IndexParams = {
  alpha: 0.35,
  sources: {
    x: { leg: "hype", weight: 0.4, tauHours: 6, enabled: true },
    reddit: { leg: "hype", weight: 0.2, tauHours: 6, enabled: true },
    search: { leg: "hype", weight: 0.2, tauHours: 6, enabled: true },
    // Amendment A16: Hacker News mentions (Algolia API, no key) so HYPE has a free source.
    hn: { leg: "hype", weight: 0.2, tauHours: 6, enabled: true },
    commits: { leg: "work", weight: 0.4, tauHours: 24, enabled: true },
    releases: { leg: "work", weight: 0.35, tauHours: 24, enabled: true },
    onchain: { leg: "work", weight: 0.25, tauHours: 24, enabled: true },
  },
  baselineDays: 30,
  zClamp: 4,
  unverifiedCredibility: 0.6,
  cohortPriorDays: 14,
  sigmaFloorAbs: 1,
  sigmaFloorRel: 0.1,
  degradedHoldMinutes: 30,
  degradedHalfLifeHours: 2,
  // Amendment: with optional sources a leg may have only two live sources; stop at 2 degraded
  // or when no enabled source is healthy.
  maxDegradedPerLeg: 2,
};

/** Hard bounds from PRD §18. Throws on violation so a bad params file never reaches the pusher. */
export function validateParams(p: IndexParams): void {
  const inRange = (name: string, v: number, lo: number, hi: number) => {
    if (!(v >= lo && v <= hi)) throw new Error(`param ${name}=${v} outside [${lo}, ${hi}]`);
  };
  inRange("alpha", p.alpha, 0.1, 0.9);
  inRange("baselineDays", p.baselineDays, 14, 90);
  inRange("zClamp", p.zClamp, 2, 6);
  inRange("unverifiedCredibility", p.unverifiedCredibility, 0.3, 1);
  for (const id of SOURCES) inRange(`${id}.tauHours`, p.sources[id].tauHours, 1, 72);
  for (const leg of ["hype", "work"] as const) {
    const ids = SOURCES.filter((s) => p.sources[s].leg === leg);
    const sum = ids.reduce((a, s) => a + p.sources[s].weight, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new Error(`${leg} weights sum to ${sum}, expected 1`);
    if (!ids.some((s) => p.sources[s].enabled)) throw new Error(`${leg} has no enabled source`);
  }
}

/** Canonical JSON (sorted keys) so the hash is stable across runtimes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `paramsVersion` carried in every push (PRD §4.5). */
export function paramsVersion(p: IndexParams): `0x${string}` {
  return keccak256(toBytes(canonicalJson(p)));
}

/** Effective weights for a leg after dropping disabled sources. */
export function legWeights(p: IndexParams, leg: Leg): Map<SourceId, number> {
  const ids = SOURCES.filter((s) => p.sources[s].leg === leg && p.sources[s].enabled);
  const sum = ids.reduce((a, s) => a + p.sources[s].weight, 0);
  return new Map(ids.map((s) => [s, p.sources[s].weight / sum]));
}

/**
 * Params for one Bloke (amendment A16): sources the Bloke has no account on, or that no collector
 * is running for, are disabled, so the leg renormalises over what it actually has.
 */
export function paramsForSources(p: IndexParams, available: ReadonlySet<SourceId>): IndexParams {
  const sources = { ...p.sources };
  for (const id of SOURCES) sources[id] = { ...sources[id], enabled: sources[id].enabled && available.has(id) };
  return { ...p, sources };
}

/** True when both legs keep at least one enabled source. */
export function computable(p: IndexParams): boolean {
  return (["hype", "work"] as const).every((leg) => SOURCES.some((s) => p.sources[s].leg === leg && p.sources[s].enabled));
}
