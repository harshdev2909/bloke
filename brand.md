# Brand — BLOKE (v2, minimal gallery)

_Status: active_ · Palette from Monad's brand colours. BLOKE is not affiliated with or endorsed by Monad.

## Principles
Minimal. One canvas, ink type, one accent. Imagery carries the visual weight; effects don't. No glows, glass or gradients on UI.

## Palette
| Token | Hex | Use |
|---|---|---|
| canvas | `#FBFAF9` | Page (Monad off-white) |
| sand / sand-2 | `#F2EFEC` / `#E9E5E1` | Tiles, hover, art grounds |
| ink / ink-2 / ink-3 | `#0E100F` / `#4A4A52` / `#6E6C78` | Text (18:1 / 8.5:1 / 4.9:1) |
| accent | `#836EF9` | Monad purple: marks, art, thin lines |
| accent-ink | `#5B44E8` | Filled buttons, links, long, WORK (white text 6.1:1) |
| deep | `#200052` | Monad blue: art masses, hover |
| berry | `#A0055D` | Short, HYPE (7.5:1) |
| pos / neg | `#0F7A55` / `#B4233F` | PnL, always with sign or arrow |

## Type
Bricolage Grotesque (display, −0.04em), Geist (UI), Geist Mono (every number, tabular).

## Shape
Tiles 28 px, art frames 40 px, controls fully round. Hairline rules (`#E4E0DC`) separate list rows.

## Art
Generated or handcrafted compositions in deep blue, purple and berry on sand, with paper grain. Never a likeness of a real person.
Slots live in `apps/web/lib/art.ts`; drop an image into `apps/web/public/art/` and register it to replace a slot's fallback.
