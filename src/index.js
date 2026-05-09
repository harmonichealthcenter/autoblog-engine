import "dotenv/config";
import cron from "node-cron";
import { listSites, loadSite } from "./sites.js";
import { generateOne } from "./generate.js";
import { publishSite } from "./publish.js";
import { listArticles } from "./db.js";
import { notify } from "./slack.js";

const cronEnabled = (process.env.CRON_ENABLED || "true").toLowerCase() !== "false";

async function runGenerationForAll() {
  for (const slug of listSites()) {
    try {
      const site = loadSite(slug);
      const schedule = site.config.schedule || {};
      if (schedule.enabled === false) continue;
      await generateOne(slug);
    } catch (err) {
      console.error(`[${slug}] generation error:`, err);
      await notify(`⚠️ Generation error [${slug}]: ${err.message}`);
    }
  }
}

async function remindStaleReviews() {
  const STALE_HOURS = 48;
  const cutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;
  for (const slug of listSites()) {
    const pending = listArticles(slug, "pending_review");
    const stale = pending.filter((a) => new Date(a.created_at + "Z").getTime() < cutoff);
    if (stale.length) {
      await notify(
        `⏰ [${slug}] ${stale.length} draft(s) pending review for >${STALE_HOURS}h:\n` +
          stale.map((a) => `• #${a.id} ${a.title}`).join("\n")
      );
    }
  }
}

if (cronEnabled) {
  // Generate Mon/Wed/Fri 9am
  cron.schedule("0 9 * * 1,3,5", () => {
    console.log(`[cron] generation tick @ ${new Date().toISOString()}`);
    runGenerationForAll();
  });

  // Stale review reminder Mon/Wed/Fri 10am
  cron.schedule("0 10 * * 1,3,5", () => {
    console.log(`[cron] stale-review tick @ ${new Date().toISOString()}`);
    remindStaleReviews();
  });

  // Publish approved drafts hourly (catches anything approved between cron runs)
  cron.schedule("15 * * * *", () => {
    console.log(`[cron] publish tick @ ${new Date().toISOString()}`);
    for (const slug of listSites()) {
      publishSite(slug).catch((e) => console.error(`[${slug}] publish:`, e));
    }
  });

  console.log(`autoblog-engine running. Sites: ${listSites().join(", ") || "(none)"}`);
} else {
  console.log("autoblog-engine started with CRON_ENABLED=false (idle).");
}

// Keep alive
setInterval(() => {}, 1 << 30);
