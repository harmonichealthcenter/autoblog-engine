import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import "dotenv/config";

const dbPath = process.env.DB_PATH || path.resolve("./data/autoblog.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    site          TEXT NOT NULL,
    topic_id      TEXT NOT NULL,
    slug          TEXT NOT NULL,
    title         TEXT,
    primary_keyword TEXT,
    word_count    INTEGER,
    draft_path    TEXT,
    status        TEXT NOT NULL DEFAULT 'draft',
    reject_reason TEXT,
    published_url TEXT,
    cost_cents    INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(site, status);
`);

export function insertArticle(row) {
  const stmt = db.prepare(`
    INSERT INTO articles (site, topic_id, slug, title, primary_keyword, word_count, draft_path, status, cost_cents)
    VALUES (@site, @topic_id, @slug, @title, @primary_keyword, @word_count, @draft_path, @status, @cost_cents)
  `);
  return stmt.run(row).lastInsertRowid;
}

export function updateArticle(id, patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE articles SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...patch, id });
}

export function getArticle(id) {
  return db.prepare(`SELECT * FROM articles WHERE id = ?`).get(id);
}

export function getArticleBySlug(site, slug) {
  return db.prepare(`SELECT * FROM articles WHERE site = ? AND slug = ?`).get(site, slug);
}

export function listArticles(site, status) {
  if (status) {
    return db.prepare(`SELECT * FROM articles WHERE site = ? AND status = ? ORDER BY created_at DESC`).all(site, status);
  }
  return db.prepare(`SELECT * FROM articles WHERE site = ? ORDER BY created_at DESC`).all(site);
}
