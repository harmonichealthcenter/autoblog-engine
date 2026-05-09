// Fetch a site's sitemap.xml and return a flat list of URLs.
// Used to give the model real internal links it can reference.

const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 6;

export async function fetchSitemapUrls(siteUrl) {
  const key = siteUrl;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.urls;

  const url = siteUrl.replace(/\/$/, "") + "/sitemap.xml";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "autoblog-engine/0.1" } });
    if (!res.ok) {
      console.warn(`[sitemap] ${url} returned ${res.status} — proceeding without internal link list`);
      return [];
    }
    const xml = await res.text();
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    cache.set(key, { ts: Date.now(), urls });
    return urls;
  } catch (err) {
    console.warn(`[sitemap] fetch failed: ${err.message}`);
    return [];
  }
}
