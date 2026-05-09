import "dotenv/config";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { listArticles, getArticle, updateArticle } from "./db.js";
import { listSites, loadSite, readTopics, writeTopics } from "./sites.js";

function fmtRow(a) {
  const cost = `$${((a.cost_cents || 0) / 100).toFixed(2)}`;
  return `#${String(a.id).padEnd(4)} [${a.site}] ${a.status.padEnd(15)} ${String(a.word_count || "?").padStart(5)}w  ${cost.padStart(7)}  ${a.title || a.slug}`;
}

function cmdList() {
  const status = process.argv[3] || "pending_review";
  const site = process.argv[4];
  const sites = site ? [site] : listSites();
  let any = false;
  for (const s of sites) {
    const rows = listArticles(s, status === "all" ? null : status);
    if (rows.length === 0) continue;
    any = true;
    console.log(`\n=== ${s} (${status}) ===`);
    for (const a of rows) console.log(fmtRow(a));
  }
  if (!any) console.log(`No articles with status "${status}".`);
}

function cmdShow() {
  const id = parseInt(process.argv[3], 10);
  const a = getArticle(id);
  if (!a) return console.error(`No article #${id}`);
  console.log(`\n${"=".repeat(72)}\n#${a.id} — ${a.title}\nStatus: ${a.status}  Site: ${a.site}  Slug: ${a.slug}\nWords: ${a.word_count}  Cost: $${((a.cost_cents || 0) / 100).toFixed(2)}\nDraft: ${a.draft_path}\n${"=".repeat(72)}\n`);
  if (a.draft_path && fs.existsSync(a.draft_path)) {
    console.log(fs.readFileSync(a.draft_path, "utf8"));
  } else {
    console.error(`Draft file missing: ${a.draft_path}`);
  }
}

function cmdApprove() {
  const id = parseInt(process.argv[3], 10);
  const a = getArticle(id);
  if (!a) return console.error(`No article #${id}`);
  updateArticle(id, { status: "approved" });
  console.log(`✅ #${id} approved → run \`npm run publish\` to push to CMS repo.`);
}

function cmdReject() {
  const id = parseInt(process.argv[3], 10);
  const reason = process.argv.slice(4).join(" ") || "no reason given";
  const a = getArticle(id);
  if (!a) return console.error(`No article #${id}`);
  updateArticle(id, { status: "rejected", reject_reason: reason });

  // Re-queue the topic so we try again
  const site = loadSite(a.site);
  const topics = readTopics(site);
  const t = topics.find((x) => x.id === a.topic_id);
  if (t && t.status === "drafted") {
    t.status = "queued";
    t.last_reject_reason = reason;
    writeTopics(site, topics);
  }
  console.log(`❌ #${id} rejected: ${reason}`);
  console.log(`Topic ${a.topic_id} re-queued. Use the reason to refine the system prompt before re-running.`);
}

function cmdEdit() {
  const id = parseInt(process.argv[3], 10);
  const a = getArticle(id);
  if (!a) return console.error(`No article #${id}`);
  if (!a.draft_path || !fs.existsSync(a.draft_path)) return console.error(`Draft file missing`);
  const editor = process.env.EDITOR || "vi";
  const child = spawn(editor, [a.draft_path], { stdio: "inherit" });
  child.on("close", (code) => {
    if (code === 0) {
      // Recompute word count
      const text = fs.readFileSync(a.draft_path, "utf8");
      const body = text.replace(/^---[\s\S]*?---\s*/, "");
      const wc = body.trim().split(/\s+/).length;
      updateArticle(id, { status: "approved", word_count: wc });
      console.log(`✏️  #${id} edited and approved (${wc} words).`);
    } else {
      console.error(`Editor exited ${code}, no changes recorded.`);
    }
  });
}

const cmd = process.argv[2];
const handlers = { list: cmdList, show: cmdShow, approve: cmdApprove, reject: cmdReject, edit: cmdEdit };
const handler = handlers[cmd];
if (!handler) {
  console.error(`Usage:
  node src/review.js list [status] [site]
  node src/review.js show <id>
  node src/review.js approve <id>
  node src/review.js reject <id> "reason"
  node src/review.js edit <id>`);
  process.exit(1);
}
handler();
