/** Index ticks and the synthetic walk used for Blokes without real sources (and for P0 demos). */

export interface IndexTick {
  blokeId: number;
  /** Scaled ×1e4 (100.0 → 1_000_000). */
  b: number;
  h: number;
  w: number;
  /** index-compute marks a Bloke stopped when ≥ 2 sources in a leg are degraded; it is not pushed. */
  stopped: boolean;
}

export interface IndexSource {
  paramsVersion(): `0x${string}`;
  latest(nowMs: number): IndexTick[];
}

export const SYNTHETIC_PARAMS_VERSION = "0x73796e7468657469632d76310000000000000000000000000000000000000000" as const; // "synthetic-v1"

/** Deterministic mulberry32 PRNG so synthetic runs reproduce exactly from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic index for P0 and local demos: each leg follows a mean-reverting random walk in z-space,
 * squashed exactly like the real index, so values stay in (0, 200) and centre on 100.
 */
export class SyntheticSource implements IndexSource {
  private readonly z = new Map<number, { h: number; w: number }>();
  private readonly rand: () => number;
  private lastMs: number | undefined;

  constructor(
    private readonly blokeIds: number[],
    seed = 1,
    // ~0.2% per 30 s on $NAME: about as smooth as the real decayed index, and inside the 1% default slippage.
    private readonly volPerSqrtMin = 0.01,
    private readonly alpha = 0.35,
  ) {
    this.rand = mulberry32(seed);
    for (const id of blokeIds) this.z.set(id, { h: 0, w: 0 });
  }

  /**
   * Continues the walk from values already on chain (scaled ×1e4), so a restart doesn't jump the
   * index back to 100 and trigger a run of clamped catch-up pushes.
   */
  seed(blokeId: number, hScaled: number, wScaled: number): void {
    const inv = (scaled: number) => {
      const x = Math.min(Math.max(scaled / 1e6, 1e-6), 2 - 1e-6); // squash output in (0, 2)
      return -Math.log(2 / x - 1);
    };
    if (this.z.has(blokeId) && hScaled > 0 && wScaled > 0) this.z.set(blokeId, { h: inv(hScaled), w: inv(wScaled) });
  }

  paramsVersion(): `0x${string}` {
    return SYNTHETIC_PARAMS_VERSION;
  }

  latest(nowMs: number): IndexTick[] {
    const dtMin = this.lastMs === undefined ? 0 : Math.max(0, (nowMs - this.lastMs) / 60_000);
    this.lastMs = nowMs;
    const sd = this.volPerSqrtMin * Math.sqrt(dtMin);
    return this.blokeIds.map((id) => {
      const s = this.z.get(id)!;
      s.h = s.h * Math.exp(-0.01 * dtMin) + sd * this.gauss();
      s.w = s.w * Math.exp(-0.005 * dtMin) + sd * 0.6 * this.gauss();
      const H = 2 / (1 + Math.exp(-s.h));
      const W = 2 / (1 + Math.exp(-s.w));
      const scale = (x: number) => Math.round(x * 100 * 1e4);
      return { blokeId: id, b: scale(this.alpha * H + (1 - this.alpha) * W), h: scale(H), w: scale(W), stopped: false };
    });
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
