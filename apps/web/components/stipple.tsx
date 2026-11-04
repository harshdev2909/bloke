import Image from "next/image";
import { STIPPLE, type StippleName } from "@/lib/stipple";
import { cn } from "@/lib/cn";

/** A stippled sculpture on a sand tile, the same frame as the archetype cards. */
export function Stipple({ name, className, sizes = "360px", priority }: { name: StippleName; className?: string; sizes?: string; priority?: boolean }) {
  const s = STIPPLE[name];
  return (
    <figure className={cn("rounded-[32px] bg-sand p-6", className)}>
      <div className="relative" style={{ aspectRatio: s.ratio }}>
        <Image src={s.src} alt={s.alt} fill sizes={sizes} priority={priority} className="object-contain mix-blend-multiply" />
      </div>
    </figure>
  );
}
