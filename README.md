# autoblog-engine

Multi-site supervised SEO autoblog. Generates Claude-written drafts on a cron, queues them for human review, publishes approved drafts to a Git-backed content repo per site.

## What it does

1. **Cron trigger** (Mon/Wed/Fri 9am): for each enabled site, picks the highest-priority queued topic.
2. **4-stage Claude chain**:
   - Outline (Haiku, cheap) — must include an "ANGLE:" line stating the original take.
   - Draft (Opus 4.7) — full article from the outline.
   - Self-critique (Opus 4.7) — checks against hard rules (em dashes, medical claims, RESONANCE CTA, internal links, forbidden phrases, generic openers).
   - Revise (Opus 4.7) — applies the critique.
3. **Save** to `sites/<site>/drafts/<topic-id>-<slug>.md` with YAML frontmatter, mark `pending_review` in SQLite, ping Slack.
4. **Human review** via CLI (`npm run review:list/show/approve/reject/edit`).
5. **Publish** approved drafts via GitHub Contents API to a configured target repo (e.g. the Qiari webapp's `content/blog/` folder).

Nothing publishes without explicit human approval.

## Project shape

```
autoblog-engine/
├── src/                     # generic, site-agnostic engine
│   ├── index.js             # cron entry
│   ├── generate.js          # 4-stage chain
│   ├── review.js            # CLI
│   ├── publish.js           # publish loop
│   ├── anthropic.js         # SDK + cost calc
│   ├── db.js                # sqlite
│   ├── sites.js             # per-site config loader
│   ├── slack.js
│   ├── sitemap.js           # fetch internal-link pool
│   └── adapters/
│       └── github.js        # GitHub Contents API publish adapter
└── sites/
    └── qiari/
        ├── config.json
        ├── system-prompt.md
        ├── article-types/
        │   ├── pillar.md
        │   ├── comparison.md
        │   ├── howto.md
        │   └── question.md
        ├── topics.json      # 60 seed topics across 4 keyword tiers
        ├── drafts/          # awaiting review
        └── published/       # archive after publish
```

Add another site by dropping a new `sites/<slug>/` folder with the same shape. The cron loop picks it up automatically.

The second active site is **qicoil** (Qicoil.com). It runs three parallel content streams (reputation / biohacking / educational), uses its own three article-type templates, and turns on the per-site compliance gate (see "Per-site compliance" below).

## Setup

```bash
cd /Users/ai/autoblog-engine
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY
# fill in SITE_QIARI_GITHUB_TOKEN and SITE_QIARI_GITHUB_REPO when you know where to publish
# fill in SLACK_WEBHOOK_URL when you have it
```

## CLI

```bash
# Generate one draft for a site immediately
npm run generate qiari

# Review queue
npm run review:list                    # default: pending_review across all sites
npm run review:list approved qiari
npm run review:show 12
npm run review:approve 12
npm run review:reject 12 "tone too clinical, soften the mechanism section"
npm run review:edit 12                 # opens $EDITOR; on save, marks approved

# Push approved drafts to target repos
npm run publish
npm run publish qiari
```

## Cron schedule (active when `npm start` is running)

| Cron | What |
|------|------|
| `0 9 * * 1,3,5` | Generate one draft per site |
| `0 10 * * 1,3,5` | Slack reminder for any draft pending review > 48h |
| `15 * * * *` | Push approved drafts to target repos |

Disable with `CRON_ENABLED=false`.

## Hard content rules (enforced via system prompt + critique stage)

- No em dashes (—). Hard rule.
- No medical claims (treats / cures / heals / FDA approved / clinical).
- No labeled "Introduction"/"Conclusion" sections.
- No bullet-list-only articles — flowing prose under H2/H3.
- One internal link per 250 words minimum, only from the site's real sitemap URLs.
- One closing CTA using the keyword "RESONANCE", phrased uniquely each article.
- Forbidden phrases: "in today's fast-paced world", "delve into", "unlock the secrets of", "harness the power of", "groundbreaking", "revolutionary", "game-changer", etc.

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a Railway project, point it at the repo. Railway will detect `railway.json` and run `node src/index.js`.
3. Set env vars in Railway:
   - `ANTHROPIC_API_KEY`
   - `SLACK_WEBHOOK_URL` (when ready)
   - `SITE_QIARI_GITHUB_TOKEN` (a fine-grained PAT with contents:write on the target repo)
   - `SITE_QIARI_GITHUB_REPO` (e.g. `david/qiari-webapp`)
   - `SITE_QICOIL_GITHUB_TOKEN` (PAT with contents:write on the qicoil target repo)
   - `SITE_QICOIL_GITHUB_REPO` (e.g. `harmonichealthcenter/qicoil-main`)
4. Mount a persistent volume at `/app/data` so the SQLite db survives redeploys.
5. Run `npm install` once locally and commit `package-lock.json` so Railway's nixpacks build is reproducible.

## Cost estimate

Per article (Opus 4.7 + Haiku 4.5 with prompt caching after first call):
- Outline: ~$0.005
- Draft: ~$0.06
- Critique: ~$0.04
- Revise: ~$0.06
- Meta: ~$0.005
- **Total: ~$0.17 per article.**

3 articles/week × 4 sites × $0.17 ≈ $2.04/week per 4-site setup. Negligible.

## Follow-up: webapp blog route

This engine only handles **generation + commit**. The Qiari webapp still needs a `/blog` route that:

1. Reads markdown from `content/blog/*.md` in the same repo (or fetches via GitHub raw URLs if the engine commits to a separate content repo).
2. Parses YAML frontmatter (use `gray-matter`).
3. Renders markdown to HTML (use `marked` or `markdown-it`).
4. Builds an index page listing posts.
5. Builds individual post pages with proper `<title>`, `<meta name="description">`, OG tags, and JSON-LD `Article` schema (critical for SEO).
6. Generates an updated `sitemap.xml` that includes the new posts.
7. Has a build hook so a new commit triggers a redeploy. (If the target repo is the Qiari webapp itself, this happens automatically on Replit/Railway/Vercel push.)

Spec that as a separate task once this engine is running.

## Image generation (Replicate / FLUX)

Each generated draft now includes a hero image, generated via Replicate's FLUX models. Default model is `black-forest-labs/flux-schnell` (~$0.003/image, 1-2s). Override per site by setting `config.image.model` to `flux-dev` (~$0.025) or `flux-1.1-pro` (~$0.04) for higher quality.

**Setup:**
```bash
# .env
REPLICATE_API_TOKEN=r8_...
```

If `REPLICATE_API_TOKEN` is unset, generation skips images silently (article still saves and the frontmatter still includes `image_prompt` for later backfill).

**Frontmatter additions:** `image`, `image_alt`, `og_image`, `twitter_card: summary_large_image`, `canonical_url`. The webapp's blog template should consume these for OG/Twitter card meta tags.

**Storage:** images live alongside the markdown — `sites/<slug>/drafts/images/<slug>.png`, then move to `published/images/` on approval. On publish, the github adapter commits both the markdown and the image to the target repo at `content/blog/<slug>.md` and `content/blog/images/<slug>.png`.

**Backfill historical articles:**
```bash
npm run backfill:images                  # all sites, drafts + published
npm run backfill:images qicoil           # one site
npm run backfill:images qiari --dry-run  # preview
npm run backfill:images qiari --published   # only published, skip drafts
```

Backfill scans for articles that have `image_prompt` in frontmatter but no `image`. Generates the image, rewrites the frontmatter to add the SEO meta block, and (for published articles) re-commits both files to the target repo.

## Per-site compliance gate

A site can opt into a compliance check that runs on the final revised draft before save. Configure under `sites/<slug>/config.json` -> `compliance`:

```json
"compliance": {
  "enabled": true,
  "required_disclaimer": "not intended to diagnose, treat, cure, or prevent any disease",
  "disclaimer_required_when_mentions": ["Qi Coil"],
  "forbidden_patterns": ["\\bcures?\\b", "FDA\\s+approved", "—"],
  "flag_for_human": ["\\bstudy\\b", "peer[-\\s]reviewed"]
}
```

- `forbidden_patterns` — any match BLOCKS publish. Draft is routed to `sites/<slug>/drafts/needs-rework/`, status `compliance_failed`, Slack ping uses 🚫.
- `disclaimer_required_when_mentions` + `required_disclaimer` — if the article mentions any trigger string but the required disclaimer text is absent, that's also a blocking failure.
- `flag_for_human` — matches surface as warnings in the frontmatter and Slack, but don't block. Reviewer verifies before approving.

Currently active for: **qicoil**. Qiari runs without compliance enabled.

## What this engine deliberately does NOT do

- No web dashboard. Slack + CLI is enough for v1.
- No auto-publish. Every article requires explicit human approval.
- No image generation. The frontmatter includes an `image_prompt` you paste into ChatGPT (or whatever) and upload manually.
- No multi-language. English only.
- No comments / community / newsletter. Out of scope.
