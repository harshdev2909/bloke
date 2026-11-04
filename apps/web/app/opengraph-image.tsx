import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "BLOKE — Back the work. Short the noise.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Social card: headline on paper beside the hero artwork, like the landing page. */
export default async function OpenGraphImage() {
  const art = await readFile(join(process.cwd(), "public/art/kandinsky-composition-8-1923.jpg"));
  const src = `data:image/jpeg;base64,${art.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#FBFAF9", padding: 56, gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 520 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <svg width="44" height="44" viewBox="0 0 32 32">
              <circle cx="16" cy="16" r="15" fill="#0E100F" />
              <path d="M11 7v18" stroke="#FBFAF9" strokeWidth="2.6" strokeLinecap="round" />
              <path d="M11 13.5c7.5 0 10.5 1.8 10.5 5.6 0 3.9-3 5.9-10.5 5.9" fill="none" stroke="#836EF9" strokeWidth="2.6" strokeLinecap="round" />
              <circle cx="22.5" cy="9" r="1.8" fill="#FBFAF9" />
            </svg>
            <span style={{ fontSize: 34, fontWeight: 700, color: "#0E100F", letterSpacing: -1 }}>bloke</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 76, fontWeight: 800, color: "#0E100F", lineHeight: 1, letterSpacing: -3 }}>Back the work.</span>
            <span style={{ fontSize: 76, fontWeight: 800, color: "#6E6C78", lineHeight: 1, letterSpacing: -3, marginTop: 8 }}>Short the noise.</span>
            <span style={{ fontSize: 26, color: "#4A4A52", marginTop: 28, lineHeight: 1.35 }}>Go long or short a builder, priced by a live index of what they ship.</span>
          </div>
          <span style={{ fontSize: 20, color: "#6E6C78" }}>Monad testnet · tUSDC has no value</span>
        </div>
        <div style={{ display: "flex", flex: 1, borderRadius: 32, overflow: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </div>
    ),
    size,
  );
}
