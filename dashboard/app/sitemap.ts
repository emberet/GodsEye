import type { MetadataRoute } from "next";

const site = (process.env.NEXT_PUBLIC_SITE_URL || "https://godseye.work").replace(/\/$/, "");
const PAGES = ["/", "/wallets", "/leaders", "/copies", "/performance", "/proof", "/groups", "/stream"];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: `${site}${p === "/" ? "" : p}`, changeFrequency: "hourly", priority: p === "/" ? 1 : 0.7 }));
}
