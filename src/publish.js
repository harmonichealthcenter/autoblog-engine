import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { listSites, loadSite, envForSite } from "./sites.js";
import { listArticles, updateArticle } from "./db.js";
import { commitFile } from "./adapters/github.js";
import { notify } from "./slack.js";

const PUBLISHED_LOG = path.resolve("./data/published.json");

function appendLog(entry) {
  let log = [];
  if (fs.existsSync(PUBLISHED_LOG)) {
    try { log = JSON.parse(fs.readFileSync(PUBLISHED_LOG, "utf8")); } catch {}
  }
  log.push(entry);
  fs.mkdirSync(path.dirname(PUBLISHED_LOG), { recursive: true });
  fs.writeFileSync(PUBLISHED_LOG, JSON.stringify(log, null, 2) + "\n");
}

async function publishSite(siteSlug) {
  const site = loadSite(siteSlug);
  const approved = listArticles(siteSlug, "approved");
  if (approved.length === 0) {
    console.log(`[${siteSlug}] no approved drafts`);
    return;
  }

  const adapter = site.config.publish?.adapter || "github";
  if (adapter !== "github") {
    throw new Error(`Site ${siteSlug}: unsupported publish adapter "${adapter}"`);
  }

  const token = envForSite(siteSlug, "GITHUB_TOKEN");
  const repo = envForSite(siteSlug, "GITHUB_REPO") || site.config.publish?.repo;
  const branch = site.config.publish?.branch || "main";
  const targetDir = site.config.publish?.path || "content/blog";

  if (!token || !repo) {
    console.error(`[${siteSlug}] missing SITE_${siteSlug.toUpperCase()}_GITHUB_TOKEN or _GITHUB_REPO`);
    return;
  }

  for (const a of approved) {
    if (!a.draft_path || !fs.existsSync(a.draft_path)) {
      console.error(`[${siteSlug}] #${a.id} draft file missing — skipping`);
      continue;
    }
    const content = fs.readFileSync(a.draft_path, "utf8");
    const targetPath = `${targetDir.replace(/\/$/, "")}/${a.slug}.md`;
    const message = `autoblog: publish "${a.title}" (article #${a.id})`;
    try {
      const result = await commitFile({ token, repo, branch, path: targetPath, content, message });
      const publishedUrl = result.html_url;
      updateArticle(a.id, { status: "published", published_url: publishedUrl });

      // Move local draft → published/
      fs.mkdirSync(site.publishedDir, { recursive: true });
      const movedTo = path.join(site.publishedDir, path.basename(a.draft_path));
      fs.renameSync(a.draft_path, movedTo);
      updateArticle(a.id, { draft_path: movedTo });

      appendLog({
        site: siteSlug,
        article_id: a.id,
        slug: a.slug,
        title: a.title,
        committed_to: `${repo}:${targetPath}`,
        commit_sha: result.commit_sha,
        url: publishedUrl,
        published_at: new Date().toISOString(),
      });

      await notify(`✅ Published [${siteSlug}] #${a.id}: *${a.title}*\n${publishedUrl}\nIf the site doesn't auto-deploy, trigger a build.`);
      console.log(`[${siteSlug}] #${a.id} → ${repo}:${targetPath}`);
    } catch (err) {
      console.error(`[${siteSlug}] #${a.id} publish failed: ${err.message}`);
      await notify(`⚠️ Publish failed [${siteSlug}] #${a.id}: ${err.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  const sites = slug ? [slug] : listSites();
  Promise.all(sites.map((s) => publishSite(s).catch((e) => console.error(`[${s}]`, e))));
}

export { publishSite };
