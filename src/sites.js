import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_DIR = path.resolve(__dirname, "..", "sites");

export function listSites() {
  return fs
    .readdirSync(SITES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function loadSite(slug) {
  const dir = path.join(SITES_DIR, slug);
  const configPath = path.join(dir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config.json for site "${slug}" at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const systemPrompt = fs.readFileSync(path.join(dir, "system-prompt.md"), "utf8");
  const topicsPath = path.join(dir, "topics.json");
  const articleTypesDir = path.join(dir, "article-types");

  const articleTypes = {};
  for (const f of fs.readdirSync(articleTypesDir)) {
    if (f.endsWith(".md")) {
      articleTypes[f.replace(/\.md$/, "")] = fs.readFileSync(path.join(articleTypesDir, f), "utf8");
    }
  }

  return {
    slug,
    dir,
    config,
    systemPrompt,
    articleTypes,
    topicsPath,
    draftsDir: path.join(dir, "drafts"),
    publishedDir: path.join(dir, "published"),
  };
}

export function readTopics(site) {
  return JSON.parse(fs.readFileSync(site.topicsPath, "utf8"));
}

export function writeTopics(site, topics) {
  fs.writeFileSync(site.topicsPath, JSON.stringify(topics, null, 2) + "\n");
}

export function envForSite(slug, key) {
  const upper = slug.toUpperCase();
  return process.env[`SITE_${upper}_${key}`];
}
