import { idx } from "@/lib/format";
import { arcPath } from "@/lib/sigil";

/**
 * Twin arcs: HYPE (berry, left) and WORK (violet, right) meet at the top. Each arc fills toward the
 * apex as its leg rises from 0 to 200. Values are also printed, so colour is never the only signal.
 */
export function TwinArc({ h, w, size = 120 }: { h: number; w: number; size?: number }) {
  const r = 40;
  const len = (Math.PI * 2 * r * 135) / 360; // each leg spans 135°
  const frac = (v: number) => Math.max(0, Math.min(1, v / 2_000_000));
  // Angles: 0° at the top, clockwise. HYPE runs bottom-left → apex, WORK apex → bottom-right.
  const left = arcPath(50, 52, r, 225, 135);
  const right = arcPath(50, 52, r, 0, 135);
  const fh = frac(h);
  const fw = frac(w);
  return (
    <figure className="relative flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 100 100" style={{ width: size, height: size * 0.82 }} aria-hidden>
        <path d={left} fill="none" stroke="#0E100F" strokeOpacity="0.08" strokeWidth="7" strokeLinecap="round" />
        <path d={right} fill="none" stroke="#0E100F" strokeOpacity="0.08" strokeWidth="7" strokeLinecap="round" />
        <path
          d={left}
          fill="none"
          stroke="#A0055D"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${len * fh} ${len * 2}`}
          className="transition-[stroke-dasharray] duration-300 ease-out"
        />
        {/* WORK's path starts at the apex, so draw only its last `fw` share: it grows up from the bottom. */}
        <path
          d={right}
          fill="none"
          stroke="#5B44E8"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`0 ${len * (1 - fw)} ${len * fw} ${len * 2}`}
          className="transition-[stroke-dasharray] duration-300 ease-out"
        />
      </svg>
      <figcaption className="-mt-1 flex w-full justify-between px-1 text-[11px] leading-tight">
        <span className="text-left">
          <span className="block text-ink-3">HYPE</span>
          <span className="num text-berry">{idx(h)}</span>
        </span>
        <span className="text-right">
          <span className="block text-ink-3">WORK</span>
          <span className="num text-accent-ink">{idx(w)}</span>
        </span>
      </figcaption>
    </figure>
  );
}

/** Smooth sparkline (Catmull-Rom → cubic Bézier) so lines are curved, never jagged. */
export function Sparkline({ values, className = "h-10 w-full", tone = "violet" }: { values: number[]; className?: string; tone?: "violet" | "mint" | "coral" }) {
  if (values.length < 2) return <div className={`${className} rounded-full bg-sand`} aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - ((v - min) / span) * 24] as const);
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  const color = tone === "mint" ? "#0F7A55" : tone === "coral" ? "#B4233F" : "#5B44E8";
  const gid = `spark-${tone}`;
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.14" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L 100 32 L 0 32 Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
    </svg>
  );
}
