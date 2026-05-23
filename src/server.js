// Lightweight HTTP server for approval workflow. No framework — node:http only.
// Endpoints (all guarded by HMAC token in ?t):
//   GET  /approve/:id?t=...   -> mark approved, next publish tick will commit
//   GET  /reject/:id?t=...    -> mark rejected, removes from queue
//   GET  /edit/:id?t=...      -> show textarea with full draft
//   POST /edit/:id?t=...      -> save edited body, mark approved
//   GET  /healthz             -> ok
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { listArticles, updateArticle } from "./db.js";
import { verifyToken } from "./approval-tokens.js";

const PORT = Number(process.env.PORT) || 3000;

function getArticleById(id) {
  // Linear scan is fine: ~hundreds of articles. listArticles returns DESC by created_at.
  for (const slug of ["qicoil", "qiari"]) {
    const all = listArticles(slug, null);
    const found = all.find((a) => a.id === Number(id));
    if (found) return found;
  }
  return null;
}

function html(s) {
  return s.replace(/[<&>'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" }[c]));
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:840px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.5rem}textarea{width:100%;min-height:480px;font-family:ui-monospace,Menlo,monospace;font-size:13px;padding:.75rem;border:1px solid #ccc;border-radius:6px}
.btn{display:inline-block;background:#0a7;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;border:none;cursor:pointer;font-size:1rem}
.btn.warn{background:#c33}.meta{color:#666;font-size:.9rem;margin:.5rem 0 1rem}
.ok{background:#e7f6ef;border:1px solid #0a7;padding:1rem;border-radius:6px}
.err{background:#fdecec;border:1px solid #c33;padding:1rem;border-radius:6px}
pre{background:#f6f6f6;padding:.5rem;border-radius:4px;white-space:pre-wrap}
</style></head><body>${body}</body></html>`;
}

function sendHtml(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function notFound(res) {
  sendHtml(res, 404, page("Not found", "<h1>Not found</h1>"));
}

function bad(res, msg) {
  sendHtml(res, 400, page("Error", `<h1>Error</h1><div class="err">${html(msg)}</div>`));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApprove(res, articleId) {
  const a = getArticleById(articleId);
  if (!a) return notFound(res);
  if (a.status === "published") {
    return sendHtml(res, 200, page("Already published", `<h1>Already published</h1><p>${html(a.title)}</p>`));
  }
  updateArticle(a.id, { status: "approved" });
  sendHtml(
    res,
    200,
    page(
      "Approved",
      `<h1>✅ Approved</h1><div class="ok"><strong>#${a.id} — ${html(a.title)}</strong><br>Will be published on the next hourly publish tick (within ~60 min).</div>`
    )
  );
}

async function handleReject(res, articleId) {
  const a = getArticleById(articleId);
  if (!a) return notFound(res);
  updateArticle(a.id, { status: "rejected", reject_reason: "rejected via email link" });
  sendHtml(res, 200, page("Rejected", `<h1>🗑 Rejected</h1><p>${html(a.title)}</p>`));
}

async function handleEditGet(res, articleId) {
  const a = getArticleById(articleId);
  if (!a) return notFound(res);
  if (!a.draft_path || !fs.existsSync(a.draft_path)) {
    return bad(res, "Draft file no longer exists on disk.");
  }
  const body = fs.readFileSync(a.draft_path, "utf8");
  // Form has no action, so POSTing preserves the ?t=... token from the GET URL.
  sendHtml(
    res,
    200,
    page(
      `Edit #${a.id}`,
      `<h1>✏️ Edit draft #${a.id}</h1>
      <div class="meta">${html(a.title)} · ${a.word_count || "?"} words · ${html(a.status)}</div>
      <form method="POST">
        <textarea name="content">${html(body)}</textarea>
        <p><button class="btn" type="submit">Save & approve</button></p>
      </form>`
    )
  );
}

async function handleEditPost(req, res, articleId) {
  const a = getArticleById(articleId);
  if (!a) return notFound(res);
  if (!a.draft_path) return bad(res, "Draft path missing.");
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const content = params.get("content");
  if (!content) return bad(res, "Empty content.");
  fs.mkdirSync(path.dirname(a.draft_path), { recursive: true });
  fs.writeFileSync(a.draft_path, content);
  updateArticle(a.id, { status: "approved" });
  sendHtml(
    res,
    200,
    page("Saved", `<h1>💾 Saved & approved</h1><div class="ok">#${a.id} will be published on the next hourly publish tick.</div>`)
  );
}

const ACTIONS = {
  approve: { method: "GET", handler: (req, res, id) => handleApprove(res, id) },
  reject: { method: "GET", handler: (req, res, id) => handleReject(res, id) },
  edit: {
    method: "ANY",
    handler: (req, res, id) => (req.method === "POST" ? handleEditPost(req, res, id) : handleEditGet(res, id)),
  },
};

function parseRoute(pathname) {
  const m = pathname.match(/^\/(approve|reject|edit)\/(\d+)\/?$/);
  if (!m) return null;
  return { action: m[1], id: Number(m[2]) };
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("ok");
      }
      const route = parseRoute(url.pathname);
      if (!route) return notFound(res);
      const cfg = ACTIONS[route.action];
      if (!cfg) return notFound(res);
      if (cfg.method !== "ANY" && req.method !== cfg.method) return notFound(res);

      const token = url.searchParams.get("t");
      const verified = verifyToken(token, route.action);
      if (!verified.ok) return bad(res, `Invalid or expired link (${verified.reason}).`);
      if (verified.articleId !== route.id) return bad(res, "Token / article id mismatch.");

      await cfg.handler(req, res, route.id);
    } catch (err) {
      console.error("[server]", err);
      try {
        sendHtml(res, 500, page("Error", `<h1>Server error</h1><pre>${html(String(err.message || err))}</pre>`));
      } catch {}
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] listening on :${PORT}`);
  });
  return server;
}
