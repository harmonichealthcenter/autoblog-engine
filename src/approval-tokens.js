import crypto from "node:crypto";

function getSecret() {
  const s = process.env.APPROVAL_SECRET;
  if (!s || s.length < 16) throw new Error("APPROVAL_SECRET not set (must be >=16 chars)");
  return s;
}

function sign(payload) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

// Token format: <action>.<articleId>.<exp>.<sig>
// action ∈ approve | reject | edit
export function makeToken({ action, articleId, ttlMs = 30 * 24 * 60 * 60 * 1000 }) {
  const exp = Date.now() + ttlMs;
  const payload = `${action}.${articleId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token, expectedAction) {
  if (!token || typeof token !== "string") return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [action, idStr, expStr, sig] = parts;
  if (expectedAction && action !== expectedAction) return { ok: false, reason: "action_mismatch" };
  const payload = `${action}.${idStr}.${expStr}`;
  const expected = sign(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return { ok: false, reason: "expired" };
  return { ok: true, action, articleId: Number(idStr) };
}

export function buildLinks(articleId) {
  const base = (process.env.APPROVAL_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const mk = (action) => `${base}/${action}/${articleId}?t=${makeToken({ action, articleId })}`;
  return {
    approve: mk("approve"),
    reject: mk("reject"),
    edit: mk("edit"),
  };
}
