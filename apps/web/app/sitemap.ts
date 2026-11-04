import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/portfolio", "/pool", "/raise", "/rep", "/me", "/status"].map((p) => ({ url: `${SITE_URL}${p}`, changeFrequency: "daily", priority: p === "" ? 1 : 0.6 }));
}
