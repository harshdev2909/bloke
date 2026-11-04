import { arcPath, sigil } from "@/lib/sigil";

/** A Bloke's generative mark. Decorative: the ticker is always shown next to it as text. */
export function Sigil({ ticker, h, w, size = 56, className = "" }: { ticker: string; h?: number; w?: number; size?: number; className?: string }) {
  const s = sigil(ticker, h, w);
  const id = `sg-${ticker}`;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      <defs>
        <linearGradient id={`${id}-st`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={s.hue.a} />
          <stop offset="1" stopColor={s.hue.b} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill="#F2EFEC" />
      {s.arcs.map((a, i) => (
        <path key={i} d={arcPath(50, 50, a.r, a.start, a.sweep)} fill="none" stroke={`url(#${id}-st)`} strokeWidth={a.width} strokeOpacity={a.opacity} strokeLinecap="round" />
      ))}
      {s.strokes.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#0E100F" strokeOpacity={l.opacity * 0.55} strokeWidth="1.2" strokeLinecap="round" />
      ))}
      <circle cx="50" cy="50" r={s.core.r} fill={s.hue.a} />
      <circle cx="50" cy="50" r={s.core.r * 0.45} fill="#FBFAF9" />
    </svg>
  );
}
