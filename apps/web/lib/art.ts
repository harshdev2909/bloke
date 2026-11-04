/**
 * Artwork. Every image is a public-domain work by Vasily Kandinsky (1866–1944), downloaded from
 * Wikimedia Commons. Only pre-1930 works are used, so they're public domain in the US as well as
 * in life+70 countries. Details are crops of the same two works, keeping one visual language.
 * Generated images can replace any slot later; keep `credit` accurate when you do.
 */
export type ArtSlot = "hero" | "onboarding" | "pool" | "portfolio" | "empty" | "rep";

export interface ArtImage {
  src: string;
  alt: string;
  credit: string;
  /** Intrinsic aspect ratio (w / h), so frames never letterbox. */
  ratio: number;
}

const C8 = "Vasily Kandinsky, Composition 8, 1923";
const C24 = "Vasily Kandinsky, Composition, 1924";
const PD = "Public domain, via Wikimedia Commons";

export const ART: Record<ArtSlot, ArtImage> = {
  hero: {
    src: "/art/kandinsky-composition-8-1923.jpg",
    alt: "Kandinsky's Composition 8: circles, triangles and fine black lines on a pale ground.",
    credit: `${C8}. ${PD}.`,
    ratio: 1530 / 1080,
  },
  onboarding: {
    src: "/art/kandinsky-composition-1924.jpg",
    alt: "Kandinsky watercolour: black strokes, a violet wedge and a blue oval on cream paper.",
    credit: `${C24}. ${PD}.`,
    ratio: 1600 / 1963,
  },
  pool: {
    src: "/art/detail-circles.jpg",
    alt: "Detail of Composition 8: a bridge of arcs, a checkered band and crossing lines.",
    credit: `Detail of ${C8}. ${PD}.`,
    ratio: 600 / 560,
  },
  portfolio: {
    src: "/art/detail-sun.jpg",
    alt: "Detail of Composition 8: a small circle in a soft halo.",
    credit: `Detail of ${C8}. ${PD}.`,
    ratio: 560 / 440,
  },
  rep: {
    src: "/art/detail-1924.jpg",
    alt: "Detail of a Kandinsky watercolour: a violet wedge, a black bar and a blue oval.",
    credit: `Detail of ${C24}. ${PD}.`,
    ratio: 960 / 760,
  },
  empty: {
    src: "/art/detail-grid.jpg",
    alt: "Detail of Composition 8: a small grid and crossing lines.",
    credit: `Detail of ${C8}. ${PD}.`,
    ratio: 430 / 600,
  },
};
