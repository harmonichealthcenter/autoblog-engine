// IndexNow auto-ping for newly published URLs.
// Bing, Yandex, Naver, Seznam.cz support IndexNow. Google does NOT (yet).
//
// Setup per site:
//   1. Generate a random key (8-128 chars hex), e.g. `openssl rand -hex 16`.
//   2. Host the key at the site root as `<key>.txt` with the key as the only content,
//      so search engines can verify ownership. Filename and content must match.
//   3. Set env vars:  SITE_<SLUG>_INDEXNOW_KEY=<key>  and (optional)
//      SITE_<SLUG>_INDEXNOW_HOST=<bare host>  (defaults to URL host from site_url).
//   4. In sites/<slug>/config.json add: "indexnow": { "enabled": true }.
//
// We submit to the unified endpoint api.indexnow.org. They fan out to Bing/Yandex/etc.

import { envForSite } from "./sites.js";

export async function pingIndexNow({ site, urls }) {
  const cfg = site?.config?.indexnow;
  if (!cfg || cfg.enabled === false) return { skipped: true, reason: "disabled" };

  const key = envForSite(site.slug, "INDEXNOW_KEY");
  if (!key) return { skipped: true, reason: "no SITE_<SLUG>_INDEXNOW_KEY env var" };

  const siteUrl = site.config?.site_url;
  if (!siteUrl) return { skipped: true, reason: "no site_url in config" };

  const host = envForSite(site.slug, "INDEXNOW_HOST") || new URL(siteUrl).host;
  const keyLocation = `${siteUrl.replace(/\/$/, "")}/${key}.txt`;

  const body = {
    host,
    key,
    keyLocation,
    urlList: urls,
  };

  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 422 means key file isn't reachable yet — note but don't throw
      return { ok: false, status: res.status, body: text.slice(0, 300) };
    }
    return { ok: true, status: res.status, urlCount: urls.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
