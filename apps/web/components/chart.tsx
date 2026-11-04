"use client";

import { useMemo, useRef, useState } from "react";
import type { IndexPoint, Leg } from "@bloke/sdk";
import { idx } from "@/lib/format";

const COLORS: Record<Leg, string> = { blend: "#0E100F", hype: "#A0055D", work: "#5B44E8" };

/**
 * Curved area chart of the index (smoothed with monotone Catmull-Rom so it never overshoots).
 * Pointer and arrow keys move a crosshair; a hidden table summarises the series for screen readers.
 */
export function IndexChart({ points, leg }: { points: IndexPoint[]; leg: Leg }) {
  const W = 720;
  const H = 260;
  const pad = { t: 16, r: 12, b: 26, l: 12 };
  const values = points.map((p) => (leg === "blend" ? p.b : leg === "hype" ? p.h : p.w));
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const geom = useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 2_000); // never zoom past 0.2 index points
    const lo = min - span * 0.15;
    const hi = max + span * 0.15;
    const x = (i: number) => pad.l + (i / (values.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const pts = values.map((v, i) => [x(i), y(v)] as const);
    let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[i + 2] ?? p2;
      const t = 0.18;
      d += ` C ${p1[0] + (p2[0] - p0[0]) * t} ${p1[1] + (p2[1] - p0[1]) * t}, ${p2[0] - (p3[0] - p1[0]) * t} ${p2[1] - (p3[1] - p1[1]) * t}, ${p2[0]} ${p2[1]}`;
    }
    const grid = [0.25, 0.5, 0.75].map((f) => ({ y: pad.t + f * (H - pad.t - pad.b), v: hi - f * (hi - lo) }));
    return { d, pts, grid };
  }, [values]);

  if (!geom) {
    return (
      <div className="grid h-[260px] place-items-center rounded-[24px] bg-sand text-sm text-ink-2">
        Not enough history yet. The chart fills in as the index updates.
      </div>
    );
  }

  const color = COLORS[leg];
  const active = hover ?? values.length - 1;
  const [hx, hy] = geom.pts[active]!;
  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const rel = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (values.length - 1)))));
  };

  return (
    <figure className="relative">
      <figcaption className="pointer-events-none absolute left-4 top-3 z-10">
        <span className="num display text-2xl font-semibold" style={{ color }}>
          {idx(values[active])}
        </span>
        <span className="ml-2 text-xs text-ink-3">{new Date(points[active]!.t).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}</span>
      </figcaption>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[260px] w-full touch-none select-none"
        role="img"
        aria-label={`${leg} index chart, ${values.length} points, latest ${idx(values.at(-1))}`}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setHover(Math.max(0, active - 1));
          if (e.key === "ArrowRight") setHover(Math.min(values.length - 1, active + 1));
        }}
        style={{ borderRadius: 24 }}
      >
        <defs>
          <linearGradient id={`area-${leg}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.1" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geom.grid.map((g) => (
          <g key={g.y}>
            <line x1={pad.l} x2={W - pad.r} y1={g.y} y2={g.y} stroke="#0E100F" strokeOpacity="0.08" strokeDasharray="2 6" />
            <text x={W - pad.r} y={g.y - 4} textAnchor="end" className="num fill-[#6E6C78] text-[10px]">
              {idx(Math.round(g.v))}
            </text>
          </g>
        ))}
        <path d={`${geom.d} L ${geom.pts.at(-1)![0]} ${H - pad.b} L ${geom.pts[0]![0]} ${H - pad.b} Z`} fill={`url(#area-${leg})`} />
        <path d={geom.d} fill="none" stroke={color} strokeWidth="2.25" strokeLinecap="round" />
        <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} stroke="#0E100F" strokeOpacity="0.15" />
        <circle cx={hx} cy={hy} r="9" fill={color} fillOpacity="0.12" />
        <circle cx={hx} cy={hy} r="4.5" fill={color} stroke="#FBFAF9" strokeWidth="2" />
      </svg>
      <table className="sr-only">
        <caption>Recent values</caption>
        <tbody>
          {points.slice(-10).map((p, i) => (
            <tr key={p.t}>
              <td>{p.t}</td>
              <td>{idx(values[values.length - Math.min(10, points.length) + i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
