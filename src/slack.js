import "dotenv/config";

export async function notify(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log(`[slack:stub] ${text}`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`[slack] ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`[slack] ${err.message}`);
  }
}
