/**
 * Stipple sculptures beyond the archetypes, rendered by scripts/art/stipple.mjs from CC0 photographs
 * in The Metropolitan Museum of Art's Open Access collection (object ids below).
 */
export type StippleName = "athena" | "chrysippos" | "constantine" | "philosopher";

export const STIPPLE: Record<StippleName, { src: string; alt: string; ratio: number; credit: string }> = {
  athena: { src: "/art/stipple/athena.png", alt: "Stippled marble bust of Athena.", ratio: 1040 / 1192, credit: "Marble head and torso of Athena, Roman. The Met, 251476, CC0." },
  chrysippos: { src: "/art/stipple/chrysippos.png", alt: "Stippled marble portrait of the philosopher Chrysippos.", ratio: 1040 / 1164, credit: "Marble portrait head of the philosopher Chrysippos, Roman. The Met, 251787, CC0." },
  constantine: { src: "/art/stipple/constantine.png", alt: "Stippled marble portrait of the emperor Constantine.", ratio: 1040 / 1330, credit: "Marble portrait head of the Emperor Constantine I, Roman. The Met, 252884, CC0." },
  philosopher: { src: "/art/stipple/philosopher.png", alt: "Stippled marble statuette of a seated philosopher.", ratio: 1040 / 1164, credit: "Marble statuette of a seated philosopher, Roman. The Met, 251460, CC0." },
};
