// Backfill: scan a site's published/drafts folders for articles that have an
// `image_prompt` in their frontmatter but no `image` field, generate the image,
// rewrite the frontmatter to add image / image_alt / og_image / twitter_card,
// and (if previously published) re-commit both the new markdown and the new image
// to the target repo.
//
// Usage:
//   node src/backfill-images.js                    # all sites, both drafts and published
//   node src/backfill-images.js qicoil             # one site
//   node src/backfill-images.js qicoil --dry-run   # preview only
//   node src/backfill-images.js qicoil --published # only published, skip drafts

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { listSites, loadSite, envForSite } from "./sites.js";
import { generateImage, imageAltFromPrompt } from "./images.js";
import { commitFile } from "./adapters/github.js";

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text, fmText: "" };
  const fmText = m[1];
  const fm = {};
  for (const line of fmText.split("\n")) {
    const km = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i);
    if (km) {
      let v = km[2].trim();
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      fm[km[1]] = v;
    }
  }
  return { fm, body: text.slice(m[0].length), fmText };
}

function rewriteFrontmatter(text, additions) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return text;
  let fm = m[1];
  for (const [k, v] of Object.entries(additions)) {
    const re = new RegExp(`^${k}:.*$`, "m");
    const line = `${k}: "${String(v).replace(/"/g, '\\"')}"`;
    if (re.test(fm)) {
      fm = fm.replace(re, line);
    } else {
      fm = fm + "\n" + line;
    }
  }
  return `---\n${fm}\n---\n` + text.slice(m[0].length);
}

async function backfillOne({ filePath, slug, dryRun, site, alsoCommit, publishedSubpath }) {
  const text = fs.readFileSync(filePath, "utf8");
  const { fm } = parseFrontmatter(text);
  if (!fm) return { skipped: true, reason: "no frontmatter" };
  if (fm.image) return { skipped: true, reason: "already has image" };
  if (!fm.image_prompt) return { skipped: true, reason: "no image_prompt" };

  const imageDir = path.join(path.dirname(filePath), "images");
  const imageFile = `${slug}.png`;
  const imageAbsPath = path.join(imageDir, imageFile);
  const relImage = `images/${imageFile}`;

  console.log(`  → ${slug}: prompt="${fm.image_prompt.slice(0, 70)}..."`);

  if (dryRun) return { skipped: false, dryRun: true };

  const result = await generateImage({ prompt: fm.image_prompt, outPath: imageAbsPath });

  const alt = imageAltFromPrompt(fm.image_prompt, fm.title);
  const canonical = site?.config?.site_url
    ? `${site.config.site_url.replace(/\/$/, "")}/blog/${slug}`
    : "";
  const additions = {
    image: relImage,
    image_alt: alt,
    og_image: relImage,
    twitter_card: "summary_large_image",
  };
  if (canonical && !fm.canonical_url) additions.canonical_url = canonical;

  const newText = rewriteFrontmatter(text, additions);
  fs.writeFileSync(filePath, newText);

  let committed = null;
  if (alsoCommit) {
    const token = envForSite(site.slug, "GITHUB_TOKEN");
    const repo = envForSite(site.slug, "GITHUB_REPO") || site.config.publish?.repo;
    const branch = site.config.publish?.branch || "main";
    const targetDir = site.config.publish?.path || "content/blog";
    if (token && repo) {
      const imgBuf = fs.readFileSync(imageAbsPath);
      await commitFile({
        token,
        repo,
        branch,
        path: `${targetDir.replace(/\/$/, "")}/${relImage}`,
        content: imgBuf,
        message: `autoblog: backfill image for "${fm.title || slug}"`,
        binary: true,
      });
      const result2 = await commitFile({
        token,
        repo,
        branch,
        path: `${targetDir.replace(/\/$/, "")}/${slug}.md`,
        content: newText,
        message: `autoblog: backfill image+SEO meta for "${fm.title || slug}"`,
      });
      committed = { repo, sha: result2.commit_sha, url: result2.html_url };
    }
  }

  return { skipped: false, sizeBytes: result.sizeBytes, costCents: result.costCents, committed };
}

async function backfillSite(siteSlug, opts) {
  const site = loadSite(siteSlug);
  console.log(`\n[${siteSlug}] backfilling...`);
  const targets = [];

  if (!opts.publishedOnly) {
    if (fs.existsSync(site.draftsDir)) {
      for (const f of fs.readdirSync(site.draftsDir)) {
        if (f.endsWith(".md")) targets.push({ filePath: path.join(site.draftsDir, f), alsoCommit: false });
      }
    }
  }
  if (fs.existsSync(site.publishedDir)) {
    for (const f of fs.readdirSync(site.publishedDir)) {
      if (f.endsWith(".md")) targets.push({ filePath: path.join(site.publishedDir, f), alsoCommit: true });
    }
  }

  let totalCost = 0;
  let processed = 0;
  for (const t of targets) {
    const slug = path.basename(t.filePath, ".md").replace(/^[a-z]+-\d+-/, ""); // strip topic-id prefix from drafts
    try {
      const r = await backfillOne({ ...t, slug, dryRun: opts.dryRun, site });
      if (!r.skipped) {
        processed++;
        totalCost += r.costCents || 0;
        console.log(`     ✓ image generated${r.committed ? `, committed @ ${r.committed.sha?.slice(0, 7)}` : ""}`);
      } else {
        console.log(`     - skipped (${r.reason})`);
      }
    } catch (e) {
      console.error(`     ✗ failed: ${e.message}`);
    }
  }
  console.log(`[${siteSlug}] ${processed} processed, $${(totalCost / 100).toFixed(2)} spent`);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const publishedOnly = args.includes("--published");
const siteArg = args.find((a) => !a.startsWith("--"));

const sites = siteArg ? [siteArg] : listSites();
for (const s of sites) {
  await backfillSite(s, { dryRun, publishedOnly });
}
