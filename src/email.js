// Gmail OAuth sender. Reuses the voice agent's GMAIL_CLIENT_ID/SECRET plus a
// stored refresh token for the sending mailbox (defaults to support@qilifestore.com).
//
// Env vars expected:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM_ADDRESS
import "dotenv/config";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

let cached = null; // { access_token, expires_at }

async function getAccessToken() {
  const now = Date.now();
  if (cached && cached.expires_at - 30_000 > now) return cached.access_token;

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("email: missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN");
  }
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`email: token refresh ${res.status} ${await res.text()}`);
  const json = await res.json();
  cached = {
    access_token: json.access_token,
    expires_at: now + (json.expires_in || 3600) * 1000,
  };
  return cached.access_token;
}

function encodeRFC2047(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = "b_" + Math.random().toString(36).slice(2);
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeRFC2047(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text || "",
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html || `<pre>${(text || "").replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</pre>`,
    "",
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

export async function sendEmail({ to, subject, text, html, from }) {
  const sender = from || process.env.GMAIL_FROM_ADDRESS;
  if (!sender) throw new Error("email: GMAIL_FROM_ADDRESS not set");
  const recipient = to || process.env.APPROVAL_TO_EMAIL;
  if (!recipient) throw new Error("email: no recipient (set APPROVAL_TO_EMAIL or pass to)");

  const accessToken = await getAccessToken();
  const mime = buildMime({ from: sender, to: recipient, subject, text, html });
  const raw = Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`email: send ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

export function emailConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN &&
      process.env.GMAIL_FROM_ADDRESS &&
      process.env.APPROVAL_TO_EMAIL
  );
}
