"use client";

import Image from "next/image";
import { type ArchetypeView, SOURCE_LABEL, VERIFICATION_LABEL } from "@bloke/sdk";
import { ARCHETYPE_ART } from "@/lib/archetypes";
import { cn } from "@/lib/cn";

/** A stippled sculpture, the archetype's sources and how BLOKE verifies the person behind it. */
export function ArchetypeCard({ a, selected, onSelect, compact }: { a: ArchetypeView; selected?: boolean; onSelect?: () => void; compact?: boolean }) {
  const art = ARCHETYPE_ART[a.id];
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="display text-2xl font-bold">{a.numeral}</span>
        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-3">
          {a.figure} · {a.domain}
        </span>
      </div>
      <div className="relative mx-auto mt-4 h-[200px] w-full">
        <Image src={art.src} alt={art.alt} fill sizes="(min-width: 1024px) 220px, 60vw" className="object-contain mix-blend-multiply" />
      </div>
      <div className="mt-5 flex items-baseline justify-between gap-3">
        <h3 className="display text-xl font-bold">{a.role}</h3>
        {a.blokes > 0 && <span className="num text-sm text-ink-3">{a.blokes}</span>}
      </div>
      {!compact && <p className="mt-1 text-sm leading-relaxed text-ink-2">{a.line}</p>}
      <Chips label="Priced on" items={[...new Set([...a.work, ...a.hype])].map((k) => SOURCE_LABEL[k])} />
      <Chips label="Verified with" items={a.verifiedWith.map((v) => VERIFICATION_LABEL[v])} tone="accent" />
    </>
  );
  const cls = cn(
    "tile flex h-full w-full flex-col justify-start p-6 text-left transition-[box-shadow,transform] duration-150 ease-out",
    selected ? "shadow-[0_0_0_2px_var(--color-accent-ink)]" : onSelect && "hover:-translate-y-0.5",
  );
  return onSelect ? (
    <button type="button" aria-pressed={selected} onClick={onSelect} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Chips({ label, items, tone }: { label: string; items: string[]; tone?: "accent" }) {
  return (
    <div className="mt-4">
      <p className="text-[11px] uppercase tracking-[0.14em] text-ink-3">{label}</p>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {items.map((t) => (
          <li key={t} className={cn("rounded-full px-3 py-1 text-xs", tone === "accent" ? "bg-accent-wash text-deep" : "bg-canvas text-ink-2")}>
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ArchetypeCardSkeleton() {
  return <div className="skeleton h-[460px] rounded-[32px]" />;
}
