import type { ArchetypeId } from "@bloke/sdk";

/**
 * Stipple art for each archetype, rendered by scripts/art/stipple.mjs from CC0 photographs in
 * The Metropolitan Museum of Art's Open Access collection (object ids below).
 */
export const ARCHETYPE_ART: Record<ArchetypeId, { src: string; alt: string; ratio: number; credit: string }> = {
  creator: { src: "/art/archetypes/apollo.png", alt: "Stippled marble head of Apollo.", ratio: 1040 / 1010, credit: "Marble head of Apollo, Roman. The Met, 255057, CC0." },
  builder: { src: "/art/archetypes/herakles.png", alt: "Stippled marble head of Herakles.", ratio: 1040 / 956, credit: "Marble head of Herakles, Roman. The Met, 250678, CC0." },
  scholar: { src: "/art/archetypes/epikouros.png", alt: "Stippled marble bust of Epikouros.", ratio: 1040 / 1220, credit: "Marble head of Epikouros, Roman. The Met, 248475, CC0." },
  trader: { src: "/art/archetypes/hermes.png", alt: "Stippled marble herm head of a bearded deity.", ratio: 1040 / 1198, credit: "Marble herm head of a bearded deity, Greek. The Met, 256121, CC0." },
  founder: { src: "/art/archetypes/augustus.png", alt: "Stippled marble portrait of the emperor Augustus.", ratio: 1040 / 1220, credit: "Marble portrait of the emperor Augustus, Roman. The Met, 247993, CC0." },
  voice: { src: "/art/archetypes/muse.png", alt: "Stippled marble head of a young woman, perhaps a muse.", ratio: 1040 / 1020, credit: "Marble head of a young woman, perhaps a muse, Greek. The Met, 248585, CC0." },
};
