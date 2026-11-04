import Image from "next/image";
import { ART, type ArtSlot } from "@/lib/art";

/** A framed artwork. Credits live in lib/art.ts (public domain needs none on screen). */
export function Art({
  slot,
  className,
  priority,
  sizes = "(min-width: 1024px) 50vw, 100vw",
}: {
  slot: ArtSlot;
  className?: string;
  priority?: boolean;
  sizes?: string;
}) {
  const a = ART[slot];
  return (
    <figure className={className}>
      <div className="relative overflow-hidden rounded-[32px] bg-sand" style={{ aspectRatio: a.ratio }}>
        <Image src={a.src} alt={a.alt} fill priority={priority} sizes={sizes} className="object-cover" />
      </div>
    </figure>
  );
}
