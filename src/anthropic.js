import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODELS = {
  generate: "claude-opus-4-7",
  meta: "claude-haiku-4-5-20251001",
};

const PRICE_PER_MTOK = {
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function costCents(model, usage) {
  const p = PRICE_PER_MTOK[model];
  if (!p) return 0;
  const inputTok = (usage.input_tokens || 0);
  const cacheRead = (usage.cache_read_input_tokens || 0);
  const cacheWrite = (usage.cache_creation_input_tokens || 0);
  const outputTok = (usage.output_tokens || 0);
  const dollars =
    (inputTok * p.input + outputTok * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000;
  return Math.round(dollars * 100);
}

// Calls Claude with a cached system prompt. The first block is the durable
// site prompt (cached), the second is per-call instructions.
export async function callClaude({ model, systemPrompt, instructions, max_tokens, prior = [] }) {
  const messages = [
    ...prior,
    { role: "user", content: instructions },
  ];

  const res = await client.messages.create({
    model,
    max_tokens,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages,
  });

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    text,
    usage: res.usage,
    cost_cents: costCents(model, res.usage),
    assistant_msg: { role: "assistant", content: res.content },
  };
}
