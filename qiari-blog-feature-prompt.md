# Replit Agent prompt — Qiari /blog feature

Copy everything below the divider and paste it into the Replit Agent input on https://replit.com/@harmonichealthc/QIARIAI, then click the blue send arrow.

---

Add a /blog feature to Qiari.ai.

**Goal.** Add a public blog system to qiari.ai that displays SEO-optimized articles fetched from a separate content repo. No CMS, no database — articles live as markdown files in a public GitHub repo and are fetched on demand with caching. The blog exists to flood Google with branded "Qiari" content and rank for long-tail wellness queries, so SEO correctness is the whole point.

**Content source.**
- Markdown files live at `https://raw.githubusercontent.com/${AUTOBLOG_REPO}/${AUTOBLOG_BRANCH}/sites/qiari/published/<slug>.md`.
- Each `.md` file has YAML frontmatter (title, slug, meta_description, primary_keyword, secondary_keywords, type, image_prompt, status) followed by an H1 and the article body in markdown.
- Add two env vars to Replit Secrets: `AUTOBLOG_REPO` (e.g. `harmonichealthc/autoblog-engine`) and `AUTOBLOG_BRANCH` (default `main`).
- List files via the GitHub Contents API: `https://api.github.com/repos/${AUTOBLOG_REPO}/contents/sites/qiari/published?ref=${AUTOBLOG_BRANCH}`. No auth needed for public repos.
- Cache the index in memory for 10 minutes; cache individual rendered articles for 1 hour. Add an admin-only POST `/api/blog/cache/clear` that purges the cache.

**Routes.**
- `GET /blog` — index page listing all articles, newest first by GitHub commit date. Show title, meta description, link to full post.
- `GET /blog/<slug>` — full article page. Renders markdown to HTML.
- `GET /api/blog/posts` — JSON list of post summaries.
- `GET /api/blog/posts/<slug>` — JSON for one post (rendered HTML + frontmatter + dates).
- `/sitemap.xml` — must now include all blog post URLs alongside whatever it already lists. Use the published date for `<lastmod>`.
- `/robots.txt` — allow `/blog` (do NOT noindex it).

**SEO requirements (critical — this is why the blog exists).** Each blog post page MUST server-side-render the correct head tags so Google sees them in the raw HTML (not after JS hydration). If the existing frontend is a SPA without SSR, add a FastAPI route that returns a server-rendered HTML shell with all SEO tags filled in for `/blog` and `/blog/<slug>` requests, served before any SPA hydration — OR just serve `/blog` purely server-side (simpler, fine for a content surface).

Required head tags per post:
- `<title>{frontmatter.title}</title>`
- `<meta name="description" content="{frontmatter.meta_description}">`
- `<link rel="canonical" href="https://www.qiari.ai/blog/{slug}">`
- Open Graph: `og:title`, `og:description`, `og:type=article`, `og:url`, `og:site_name=Qiari`, `og:image` (use a default Qiari OG image for now since image generation is deferred).
- Twitter: `twitter:card=summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`.
- JSON-LD `<script type="application/ld+json">` Article schema with: `@context`, `@type=Article`, `headline`, `description`, `datePublished` (GitHub commit date), `dateModified`, `author={"@type":"Organization","name":"Qiari"}`, `publisher` with name+logo, `mainEntityOfPage`.

The `/blog` index page also needs proper title and meta description ("Qiari Blog: Remote Frequency Wellness Articles" or similar) plus an OG tag set. All canonical URLs must use `https://www.qiari.ai` (the www version), never bare qiari.ai.

**Markdown rendering.**
- Use `python-markdown` or `markdown-it-py` with extensions for tables, fenced code, and heading anchors (slugified IDs).
- Sanitize output with `bleach` using a safe-but-permissive allowlist (allow headings, paragraphs, lists, links, code, blockquote, strong/em, images).
- Strip the leading H1 from the rendered body (the page layout already shows it as the page title).
- Frontmatter parsing: `python-frontmatter`.

**Visual style.** Match existing Qiari brand colors and typography. Reuse existing components/styling — do NOT introduce a new design system. Article body: max ~700px content width, line-height ~1.7, comfortable heading scale.

**What NOT to do.**
- Do NOT add a CMS, database table, or admin UI for posts. Markdown in GitHub IS the CMS.
- Do NOT commit any blog post markdown into this Qiari repo. Posts live ONLY in the autoblog repo and are fetched at request time.
- Do NOT add comments, social share widgets, or related-posts logic in this pass.
- Do NOT noindex `/blog` or set `robots:noindex` on posts. They MUST be indexable.

**Fallback.** If `AUTOBLOG_REPO` is not set, the `/blog` route should still render — just show "Blog coming soon" and skip the GitHub fetch.

**Acceptance criteria.**
- `https://www.qiari.ai/blog` returns a working index page (empty list is fine for v1, since autoblog hasn't published anything yet — the page should render cleanly with a "no posts yet" placeholder).
- `https://www.qiari.ai/blog/nonexistent-slug` returns a clean 404 page styled to match the site.
- View-source on any `/blog/<slug>` page shows the title, meta description, canonical, OG tags, and JSON-LD Article schema directly in the HTML (not added by client JS).
- `/sitemap.xml` includes blog URLs once at least one post exists.
- Lighthouse SEO score on a blog post page = 100.

Plan first, then build.
