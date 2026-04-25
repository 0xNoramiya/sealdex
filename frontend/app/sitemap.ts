import type { MetadataRoute } from "next";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
  "https://sealdex.fly.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const routes = ["", "/sales", "/lots", "/agents", "/settlement", "/docs"];
  return routes.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
    changeFrequency: route === "/sales" || route === "/lots" ? "hourly" : "weekly",
    priority: route === "" ? 1.0 : route === "/sales" ? 0.9 : 0.7,
  }));
}
