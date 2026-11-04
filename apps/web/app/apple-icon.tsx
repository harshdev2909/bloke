import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the mark on Monad off-white with breathing room (iOS adds its own rounding). */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#FBFAF9" }}>
        <svg width="128" height="128" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="15" fill="#0E100F" />
          <path d="M11 7v18" stroke="#FBFAF9" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M11 13.5c7.5 0 10.5 1.8 10.5 5.6 0 3.9-3 5.9-10.5 5.9" fill="none" stroke="#836EF9" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="22.5" cy="9" r="1.8" fill="#FBFAF9" />
        </svg>
      </div>
    ),
    size,
  );
}
