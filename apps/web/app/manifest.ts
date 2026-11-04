import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BLOKE — trade human capital",
    short_name: "BLOKE",
    description: "Go long or short a builder, priced by a live index of what they ship. Monad testnet.",
    start_url: "/",
    display: "standalone",
    background_color: "#FBFAF9",
    theme_color: "#FBFAF9",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
