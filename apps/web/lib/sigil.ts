/**
 * Generative sigils: each Bloke's mark is drawn from its ticker, never a photo (PRD §17.2: unclaimed
 * profiles show a monogram, not a likeness). Deterministic, so the same person always gets the same
 * mark, and it's handcrafted geometry rather than stock imagery.
 *
 *   - concentric arcs: WORK (steady, structural), their sweep set by the WORK value
 *   - a swarm of short strokes: HYPE (attention), their count set by the HYPE value
 *   - the hue shifts between Monad purple and berry with the HYPE/WORK balance
 */

export function seeded(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SigilShape {
  arcs: { r: number; start: number; sweep: number; width: number; opacity: number }[];
  strokes: { x1: number; y1: number; x2: number; y2: number; opacity: number }[];
  core: { r: number };
  hue: { a: string; b: string };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function mix(h1: string, h2: string, t: number) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(h1), p(h2)];
  return `#${a.map((v, i) => Math.round(lerp(v, b[i]!, t)).toString(16).padStart(2, "0")).join("")}`;
}

/** h and w are index values ×1e4 (1_000_000 = 100); missing values fall back to "normal". */
export function sigil(ticker: string, h = 1_000_000, w = 1_000_000): SigilShape {
  const r = seeded(ticker);
  const work = Math.min(2, Math.max(0, w / 1_000_000)); // 0..2
  const hype = Math.min(2, Math.max(0, h / 1_000_000));
  const ringCount = 3 + Math.floor(r() * 3);
  const arcs = Array.from({ length: ringCount }, (_, i) => ({
    r: 18 + i * (26 / ringCount) + r() * 2,
    start: r() * 360,
    sweep: 70 + work * 120 * (0.6 + r() * 0.4),
    width: 1.2 + r() * 2.4,
    opacity: 0.45 + r() * 0.5,
  }));
  const strokeCount = Math.round(6 + hype * 14);
  const strokes = Array.from({ length: strokeCount }, () => {
    const ang = r() * Math.PI * 2;
    const rad = 34 + r() * 12;
    const len = 2 + r() * 6;
    return {
      x1: 50 + Math.cos(ang) * rad,
      y1: 50 + Math.sin(ang) * rad,
      x2: 50 + Math.cos(ang) * (rad + len),
      y2: 50 + Math.sin(ang) * (rad + len),
      opacity: 0.3 + r() * 0.6,
    };
  });
  const tilt = hype / Math.max(0.01, hype + work); // 0 = all work, 1 = all hype
  return {
    arcs,
    strokes,
    core: { r: 6 + work * 4 },
    hue: { a: mix("#5b44e8", "#a0055d", tilt), b: mix("#200052", "#a0055d", tilt * 0.6) },
  };
}

export function arcPath(cx: number, cy: number, r: number, startDeg: number, sweepDeg: number) {
  const toRad = (d: number) => ((d - 90) * Math.PI) / 180;
  const s = toRad(startDeg);
  const e = toRad(startDeg + Math.min(359.9, sweepDeg));
  const large = sweepDeg > 180 ? 1 : 0;
  return `M ${cx + r * Math.cos(s)} ${cy + r * Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(e)} ${cy + r * Math.sin(e)}`;
}
