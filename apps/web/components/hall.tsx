import Image from "next/image";
import { HALL } from "@/lib/hall";

/** Hall of founders: stippled portraits of historical founders (not tradeable). */
export function HallOfFounders({ title = "Hall of founders" }: { title?: string }) {
  return (
    <section aria-labelledby="hall-h">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="hall-h" className="display text-3xl font-bold">
          {title}
        </h2>
        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-3">V · Augustus · Founders</span>
      </div>
      <ul className="-mx-4 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 [scrollbar-width:none] md:-mx-0 md:px-0">
        {HALL.map((f) => (
          <li key={f.name} className="w-[220px] shrink-0 snap-start">
            <figure className="tile h-full p-5">
              <div className="relative mx-auto w-full" style={{ aspectRatio: f.ratio }}>
                <Image src={f.src} alt={`Stippled portrait of ${f.name}.`} fill sizes="200px" className="object-contain mix-blend-multiply" />
              </div>
              <figcaption className="mt-4">
                <p className="display font-bold">{f.name}</p>
                <p className="num text-xs text-ink-3">{f.years}</p>
                <p className="mt-2 text-sm leading-snug text-ink-2">{f.founded}</p>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
