// Image generation via Replicate (FLUX). Cheap, fast, high quality for
// editorial blog hero illustrations.
//
// Default model: black-forest-labs/flux-schnell (~$0.003/image, 1-2s).
// Swap to flux-dev or flux-1.1-pro per site by setting site.config.image.model.
//
// Style guard: every prompt is augmented to keep blog hero images legally safe
// and to avoid the model rendering branded copy or recognizable people.

import fs from "node:fs";
import path from "node:path";

const REPLICATE_API = "https://api.replicate.com/v1/models";

const STYLE_GUARD =
  ", editorial blog hero illustration style, soft natural lighting, minimal composition, no people, no logos, no text on image, no watermarks";

const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

// Approximate per-image cost in cents. Rough enough for budget reporting.
const COST_CENTS = {
  "black-forest-labs/flux-schnell": 1, // ~$0.003
  "black-forest-labs/flux-dev": 3, // ~$0.025-0.030
  "black-forest-labs/flux-1.1-pro": 4, // ~$0.04
};

async function pollPrediction(predictionUrl, headers, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(predictionUrl, { headers });
    const j = await r.json();
    if (j.status === "succeeded") return j;
    if (j.status === "failed" || j.status === "canceled") {
      throw new Error(`Replicate prediction ${j.status}: ${j.error || "unknown"}`);
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  throw new Error(`Replicate prediction timed out after ${timeoutMs}ms`);
}

export async function generateImage({ prompt, outPath, model = DEFAULT_MODEL, aspectRatio = "3:2" }) {
  const apiKey = process.env.REPLICATE_API_TOKEN;
  if (!apiKey) throw new Error("REPLICATE_API_TOKEN not set in environment");

  const finalPrompt = `${prompt}${STYLE_GUARD}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Prefer: "wait",
  };

  // Use the model-specific endpoint (returns URL of generated image as output[0]).
  const res = await fetch(`${REPLICATE_API}/${model}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        output_format: "png",
        output_quality: 95,
        num_outputs: 1,
        ...(model.includes("schnell") ? { num_inference_steps: 4 } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Replicate API ${res.status}: ${body.slice(0, 500)}`);
  }

  let prediction = await res.json();

  // If `Prefer: wait` returned something still processing, poll the get URL.
  if (prediction.status !== "succeeded") {
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) {
      throw new Error(`Replicate did not return a poll URL and status=${prediction.status}`);
    }
    prediction = await pollPrediction(pollUrl, headers);
  }

  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!output || typeof output !== "string") {
    throw new Error(`Replicate returned unexpected output: ${JSON.stringify(prediction.output).slice(0, 200)}`);
  }

  // Output is a URL; download to local disk.
  const imgRes = await fetch(output);
  if (!imgRes.ok) throw new Error(`Failed to download generated image: HTTP ${imgRes.status}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);

  return {
    outPath,
    sizeBytes: buf.length,
    costCents: COST_CENTS[model] || 3,
    finalPrompt,
    model,
    sourceUrl: output,
  };
}

// Build a short alt text from the prompt + topic context. Used for accessibility + SEO.
// Kept short (under 125 chars) so screen readers don't drone, and so it works as og:image:alt.
export function imageAltFromPrompt(prompt, fallbackTitle) {
  if (!prompt) return fallbackTitle?.slice(0, 120) || "";
  const cleaned = prompt
    .replace(
      /\b(no people|no logos|no text on image|no watermarks|editorial[^,]*|soft natural lighting|minimal composition)\b/gi,
      ""
    )
    .replace(/[,.\s]+/g, " ")
    .trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + "..." : cleaned;
}
