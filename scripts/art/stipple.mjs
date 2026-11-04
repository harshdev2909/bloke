#!/usr/bin/env node
/**
 * Turns a museum photo of a sculpture into stipple art: ink dots on a transparent background,
 * denser where the stone is darker or carved (edges). Sources are CC0 images from The Met's Open
 * Access collection (credits in apps/web/lib/archetypes.ts).
 *
 * Usage: node scripts/art/stipple.mjs <in.jpg> <out.png> [--seed N] [--crop-bottom 0.12] [--mask light|abs|oval] [--thresh 0.06]
 *
 * Background removal assumes a studio photo: the backdrop is a smooth gradient, estimated per row
 * from the outer columns, and anything that differs from it (or is textured) is the subject.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// sharp ships with Next.js (image optimisation); resolve it through next rather than adding a dependency.
const sharp = createRequire(realpathSync(path.join(root, "apps/web/node_modules/next/package.json")))("sharp");

const args = process.argv.slice(2);
const [input, output] = args;
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
if (!input || !output) {
  console.error("usage: stipple.mjs <in> <out.png> [--seed N] [--crop-bottom F]");
  process.exit(1);
}

// --mask light (default): subject is lighter than the backdrop, so cast shadows drop out.
// --mask abs: any difference counts (for subjects darker than, or close to, their backdrop).
// --mask oval: portraits; everything inside a soft oval vignette.
const MASK = args.includes("--mask") ? args[args.indexOf("--mask") + 1] : "light";
const THRESH = opt("thresh", 0.06);
const W = 520; // working resolution (dots are placed here, rendered at SCALE×)
const SCALE = 2;
const INK = "#0E100F";
let seed = opt("seed", 7) >>> 0;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const img = sharp(input).greyscale().resize({ width: W });
const { data: L, info } = await img.raw().toBuffer({ resolveWithObject: true });
const w = info.width;
const h0 = info.height;
const h = Math.round(h0 * (1 - opt("crop-bottom", 0.12))); // drop the plinth
const at = (x, y) => L[y * w + x] / 255;

// Background model: per-row median of the outer 7% of columns on each side.
const edge = Math.max(4, Math.round(w * 0.07));
const bg = new Float32Array(h);
for (let y = 0; y < h; y++) {
  const s = [];
  for (let x = 0; x < edge; x++) s.push(at(x, y), at(w - 1 - x, y));
  s.sort((a, b) => a - b);
  bg[y] = s[s.length >> 1];
}

// Local gradient (Sobel magnitude) marks carving and the silhouette.
const grad = new Float32Array(w * h);
for (let y = 1; y < h - 1; y++)
  for (let x = 1; x < w - 1; x++) {
    const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
    const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    grad[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 1.2);
  }

// Subject mask: lighter than the backdrop (marble under studio light; cast shadows are darker, so
// they drop out) or carved, then a blur + threshold to close holes and drop specks.
let mask = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = (MASK === "abs" ? Math.abs(at(x, y) - bg[y]) : at(x, y) - bg[y]) > THRESH || grad[y * w + x] > 0.4 ? 1 : 0;
const blur = (m, r) => {
  const t = new Float32Array(w * h);
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w) acc += m[y * w + Math.min(w - 1, x + r)];
      if (x - r - 1 >= 0) acc -= m[y * w + x - r - 1];
      if (x >= 0 && x < w) t[y * w + x] = acc / (2 * r + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h) acc += t[Math.min(h - 1, y + r) * w + x];
      if (y - r - 1 >= 0) acc -= t[(y - r - 1) * w + x];
      if (y >= 0 && y < h) o[y * w + x] = acc / (2 * r + 1);
    }
  }
  return o;
};
mask = blur(mask, 6).map((v) => (v > 0.5 ? 1 : 0));
if (MASK === "oval") {
  // Portraits: no background removal; a soft oval vignette centred a little above the middle.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w * 0.46);
      const dy = (y - h * 0.46) / (h * 0.5);
      mask[y * w + x] = dx * dx + dy * dy <= 1 ? 1 : 0;
    }
}
// Keep the largest connected component (the sculpture), not stray backdrop blotches.
{
  const lab = new Int32Array(w * h);
  let best = 0;
  let bestN = 0;
  let next = 0;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    next++;
    let n = 0;
    stack.push(i);
    lab[i] = next;
    while (stack.length) {
      const j = stack.pop();
      n++;
      const x = j % w;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || lab[k] || !mask[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        lab[k] = next;
        stack.push(k);
      }
    }
    if (n > bestN) [best, bestN] = [next, n];
  }
  for (let i = 0; i < w * h; i++) mask[i] = lab[i] === best ? 1 : 0;
}
const soft = blur(mask, 3); // feathered silhouette so dots thin out at the edge

// Tone inside the subject, normalised to its own range so pale marble still reads.
let lo = 1;
let hi = 0;
for (let i = 0; i < w * h; i++)
  if (mask[i]) {
    const v = L[i] / 255;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
const density = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
  if (soft[i] < 0.05) continue;
  const tone = 1 - (L[i] / 255 - lo) / Math.max(0.05, hi - lo);
  density[i] = Math.min(1, (0.12 + 0.85 * tone ** 1.2 + 0.7 * grad[i]) * soft[i]);
}

// Variable-radius Poisson-disk sampling: dark areas get tight spacing, light areas sparse.
const RMIN = 1.1;
const RMAX = 6.5;
const cell = RMIN;
const gw = Math.ceil(w / cell);
const gh = Math.ceil(h / cell);
const grid = new Map();
const dots = [];
const tries = w * h * 1.4;
for (let t = 0; t < tries; t++) {
  const x = rand() * w;
  const y = rand() * h;
  const d = density[(y | 0) * w + (x | 0)];
  if (d <= 0.02) continue;
  const r = RMAX - (RMAX - RMIN) * d;
  const reach = Math.ceil(r / cell);
  const cx = (x / cell) | 0;
  const cy = (y / cell) | 0;
  let ok = true;
  for (let j = Math.max(0, cy - reach); ok && j <= Math.min(gh - 1, cy + reach); j++)
    for (let i = Math.max(0, cx - reach); i <= Math.min(gw - 1, cx + reach); i++) {
      const list = grid.get(j * gw + i);
      if (list && list.some((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 < Math.min(r, p[2]) ** 2)) {
        ok = false;
        break;
      }
    }
  if (!ok) continue;
  const p = [x, y, r, d];
  dots.push(p);
  const k = cy * gw + cx;
  (grid.get(k) ?? grid.set(k, []).get(k)).push(p);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * SCALE}" height="${h * SCALE}" viewBox="0 0 ${w} ${h}">${dots
  .map(([x, y, , d]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + 0.7 * d).toFixed(2)}"/>`)
  .join("")}</svg>`.replace("<svg ", `<svg fill="${INK}" `);
await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toFile(output);
console.log(JSON.stringify({ output, dots: dots.length, width: w * SCALE, height: h * SCALE }));
