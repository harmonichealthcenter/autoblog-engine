# Replit Agent prompt — Qiari blog hero images + per-post og:image

Copy below the divider, paste into the Replit Agent input on https://replit.com/@harmonichealthc/QIARIAI, send.

---

Extend the /blog feature to support per-post hero images and per-post og:image / twitter:image / JSON-LD image, sourced from the article's frontmatter.

**Background.** Articles in the autoblog content repo (`AUTOBLOG_REPO`, currently `harmonichealthcenter/autoblog-engine`) now ship with companion PNG images. The frontmatter has these new fields:

- `image: "images/<slug>.png"` — relative path to the hero image, located in the same `published/` folder as the markdown.
- `image_alt: "<short descriptive alt text, < 125 chars>"` — alt attribute for the image.
- `og_image: "images/<slug>.png"` — same as `image` for now; treat as override if different.
- `twitter_card: "summary_large_image"` — confirms the Twitter card type.

Companion image lives at `https://raw.githubusercontent.com/${AUTOBLOG_REPO}/${AUTOBLOG_BRANCH}/sites/qiari/published/images/<slug>.png`.

Reference live example: `https://raw.githubusercontent.com/harmonichealthcenter/autoblog-engine/main/sites/qiari/published/what-is-qiari-ai.png`

**Resolve relative image paths.** When the frontmatter `image` (or `og_image`) value starts with `images/...` (no leading `/`, no `http`), build the full URL by combining it with the article's location: `https://raw.githubusercontent.com/${AUTOBLOG_REPO}/${AUTOBLOG_BRANCH}/sites/qiari/published/<image_value>`. If the value already starts with `http://` or `https://`, use it as-is. If the value is missing or empty, fall back to the existing default Qiari OG image.

**Changes per /blog/<slug> page:**

1. **Hero image render.** At the top of the post body (above the title or just under it, whichever fits the existing post layout), render an `<img>` for the hero image. Use the resolved URL as `src`, the frontmatter `image_alt` as `alt`, `width="1536" height="1024"`, `loading="eager"`, `fetchpriority="high"`. Wrap in a `<figure>` so future captions are easy. Style: full content width (max ~700px to match body), aspect-ratio 3:2, rounded corners matching the existing card style, modest top/bottom margin.

2. **og:image override.** Replace the current `<meta property="og:image">` value with the resolved hero image URL. Add `<meta property="og:image:alt" content="{image_alt}">`. Add `<meta property="og:image:width" content="1536">` and `<meta property="og:image:height" content="1024">`.

3. **twitter:image override.** Replace `<meta name="twitter:image">` value the same way. Add `<meta name="twitter:image:alt" content="{image_alt}">`.

4. **JSON-LD Article schema.** Replace the current `image` array `["{default}"]` with `["{resolved hero URL}"]`. Keep the rest of the schema unchanged.

5. **Fallback behavior.** If the post has no `image` frontmatter field (older posts, or generation failed), keep using the existing default Qiari OG image — do NOT render a hero `<img>` in the body in that case.

**Index page (/blog) tweak.** On the index card list, add a small thumbnail of each post's hero image (if present) to the left or top of each card. Use `loading="lazy"`, the same resolved URL logic, and a smaller aspect-ratio crop. If a post has no image, render the card as it does today (no broken image placeholder).

**API responses.** `/api/blog/posts` and `/api/blog/posts/<slug>` should include the resolved image URL and image_alt in the JSON. Field names: `image_url` (resolved absolute URL), `image_alt`. This is for future use by external consumers.

**Cache invalidation.** When images change in the source repo, the existing 1-hour per-article cache will eventually pick them up. No new logic needed, but the existing admin POST `/api/blog/cache/clear` should still purge everything including image-resolved URLs.

**Acceptance:**
- View-source on https://www.qiari.ai/blog/what-is-qiari-ai shows `<meta property="og:image" content="https://raw.githubusercontent.com/harmonichealthcenter/autoblog-engine/main/sites/qiari/published/images/what-is-qiari-ai.png">` (NOT the pwa-icon).
- Same page renders the hero image visually at the top of the post.
- `/api/blog/posts` JSON for that post includes `"image_url": "https://raw.githubusercontent.com/.../what-is-qiari-ai.png"` and `"image_alt": "..."`.
- Lighthouse SEO score remains 100, and the LCP metric should still be reasonable (hero image loads with high priority, near top of HTML).
- A test fetch of an article without an `image` frontmatter field (e.g. delete `image:` line in a local test) renders the page cleanly with no broken image and falls back to the default OG.
- Sharing the article URL on Twitter / LinkedIn / Facebook / Slack pulls the hero image (not the Qiari logo) into the link preview card.

Plan first, then build.
