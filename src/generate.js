import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { listSites, loadSite, readTopics, writeTopics } from "./sites.js";
import { callClaude, MODELS } from "./anthropic.js";
import { fetchSitemapUrls } from "./sitemap.js";
import { insertArticle, updateArticle, getArticleBySlug } from "./db.js";
import { notify } from "./slack.js";
import { checkCompliance, summarizeCompliance } from "./compliance.js";
import { generateImage, imageAltFromPrompt } from "./images.js";
import { sendEmail, emailConfigured } from "./email.js";
import { buildLinks } from "./approval-tokens.js";

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function pickNextTopic(topics) {
  const queued = topics.filter((t) => t.status === "queued");
  if (queued.length === 0) return null;
  queued.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  return queued[0];
}

function buildSystemPrompt(site, internalLinks) {
  let prompt = site.systemPrompt;
  if (internalLinks.length) {
    prompt += `\n\n## Real internal links available on ${site.config.site_url}\n`;
    prompt += `Use these (and only these) when adding internal links. Pick links that are topically relevant to the article. Do NOT invent URLs.\n\n`;
    prompt += internalLinks.slice(0, 80).map((u) => `- ${u}`).join("\n");
  }
  return prompt;
}

async function stageOutline({ site, topic, systemPrompt }) {
  const articleTypePrompt =
    site.articleTypes[topic.type] ||
    site.articleTypes.howto ||
    Object.values(site.articleTypes)[0] ||
    "";
  const instructions = `
Generate a detailed outline for the following article.

ARTICLE TYPE GUIDE:
${articleTypePrompt}

TOPIC:
- Working title: ${topic.title_hint}
- Primary keyword: ${topic.primary_keyword}
- Secondary keywords: ${(topic.secondary_keywords || []).join(", ")}
- Target word count: ${topic.target_word_count}
- Type: ${topic.type}

Return the outline as markdown with H2 and H3 headings only (no body text yet). Each H2/H3 should be SEO-aware and naturally include keyword variants. Aim for 6-9 H2s.

After the outline, on a new line beginning with "ANGLE:", state the ONE original angle, claim, or framework that will make this article more than commodity AI filler. If you can't articulate a non-generic angle in one sentence, the outline is not ready.
`.trim();

  return callClaude({ model: MODELS.meta, systemPrompt, instructions, max_tokens: 1500 });
}

async function stageDraft({ site, topic, outlineText, systemPrompt }) {
  const articleTypePrompt =
    site.articleTypes[topic.type] ||
    site.articleTypes.howto ||
    Object.values(site.articleTypes)[0] ||
    "";
  const instructions = `
Write the full article based on this outline.

ARTICLE TYPE GUIDE:
${articleTypePrompt}

TOPIC:
- Working title: ${topic.title_hint}
- Primary keyword: ${topic.primary_keyword}
- Secondary keywords: ${(topic.secondary_keywords || []).join(", ")}
- Target word count: ${topic.target_word_count} (acceptable range ${Math.round(topic.target_word_count * 0.85)}-${Math.round(topic.target_word_count * 1.15)})

OUTLINE AND ANGLE:
${outlineText}

Output format: a single markdown document. Start with an H1 title. Then the article body in flowing prose under the outline's H2/H3 structure. End with a closing CTA section that uses the keyword "RESONANCE" naturally (phrased differently than any other Qiari article would).

Do NOT include YAML frontmatter — that gets added later. Do NOT label sections "Introduction" or "Conclusion."
`.trim();

  return callClaude({ model: MODELS.generate, systemPrompt, instructions, max_tokens: 8000 });
}

async function stageCritique({ systemPrompt, draftText, prior }) {
  const instructions = `
Critique the draft you just produced against the hard content rules in the system prompt.

For each of these checks, answer YES or NO and quote the offending text if NO:

1. Are there ZERO em dashes (—) in the article?
2. Are there ZERO medical claims (treats, cures, heals [disease], FDA approved, clinical efficacy implications)?
3. Does the article contain at least one specific original angle / framework / claim that is not generic SEO filler?
4. Does the article use the word "RESONANCE" exactly once, in the closing CTA?
5. Are there at least N internal links, where N = floor(word_count / 250)? Count the markdown links to the configured site domain.
6. Are any of the forbidden phrases present? (in today's fast-paced world, in this article we will explore, harness the power of, unlock the secrets of, delve into, groundbreaking, revolutionary, game-changer)
7. Is the opening paragraph specific and concrete (not a generic "in the world of wellness..." opener)?

Output format: a numbered list of the 7 checks with YES/NO and a one-line note. Then a "FIXES NEEDED:" section listing concrete edits the next pass must make. If everything passes, write "FIXES NEEDED: none."
`.trim();

  return callClaude({
    model: MODELS.generate,
    systemPrompt,
    instructions,
    max_tokens: 2000,
    prior,
  });
}

async function stageRevise({ systemPrompt, critiqueText, prior }) {
  const instructions = `
Apply the fixes from your critique and output the FINAL article. Output the complete revised markdown article only — no preamble, no commentary, no critique notes. Start with the H1 title.
`.trim();

  return callClaude({
    model: MODELS.generate,
    systemPrompt,
    instructions,
    max_tokens: 8000,
    prior,
  });
}

// Rescue pass: invoked when checkCompliance() returns blocking violations on the
// revised draft. Feeds the exact failing patterns back to the model so it can
// rewrite those passages. Output is a full replacement article.
async function stageRescue({ systemPrompt, blockingList, prior }) {
  const violations = blockingList
    .map((b) => `- pattern \`${b.pattern}\` matched "${b.match}" (rewrite to remove)`)
    .join("\n");
  const instructions = `
Your previous article failed the site's compliance gate. The following hard-blocking patterns matched in your text — you must rewrite the affected passages so they no longer appear (except inside the literal FDA disclaimer, which must remain verbatim):

${violations}

Rewrite the FULL article from scratch keeping the same outline, primary keyword, length, internal links, and meta — but with the violating language replaced by experiential / non-medical phrasing as described in the system prompt. Re-include the mandatory FDA disclaimer verbatim if Qi Coil benefits are mentioned.

Output ONLY the rewritten markdown article, starting with the H1. No preamble, no commentary.
`.trim();
  return callClaude({
    model: MODELS.generate,
    systemPrompt,
    instructions,
    max_tokens: 8000,
    prior,
  });
}

async function stageMeta({ systemPrompt, finalText, topic }) {
  const instructions = `
For the article below, produce JSON with this exact shape and nothing else:

{
  "title": "<final SEO title, max 60 chars, must contain primary keyword>",
  "meta_description": "<155-char meta description, must contain primary keyword, must not be clickbait>",
  "slug": "<url-safe-slug-max-60-chars>",
  "image_prompt": "<one-sentence prompt for an illustrative featured image, no people, no logos, no text on image>"
}

Primary keyword: ${topic.primary_keyword}

Article:
---
${finalText.slice(0, 6000)}
---
`.trim();

  const res = await callClaude({ model: MODELS.meta, systemPrompt, instructions, max_tokens: 800 });
  let parsed = {};
  try {
    const match = res.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : res.text);
  } catch {
    parsed = {};
  }
  return { ...res, parsed };
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

function buildFrontmatter({ meta, topic, internalLinkCount, costCents, compliance, status, image, site }) {
  const complianceLine =
    compliance && compliance.enabled
      ? `compliance_status: "${compliance.blocking.length ? "failed" : compliance.flags.length ? "flagged" : "clean"}"
compliance_summary: ${JSON.stringify(summarizeCompliance(compliance))}
`
      : "";
  const streamLine = topic.stream ? `stream: "${topic.stream}"\n` : "";
  const slug = meta.slug || slugify(meta.title || topic.title_hint);
  const canonical = site?.config?.site_url
    ? `${site.config.site_url.replace(/\/$/, "")}/blog/${slug}`
    : "";
  const imageBlock = image
    ? `image: "${image.relativePath}"
image_alt: "${(image.alt || "").replace(/"/g, '\\"')}"
og_image: "${image.relativePath}"
twitter_card: "summary_large_image"
`
    : "";
  const canonicalLine = canonical ? `canonical_url: "${canonical}"\n` : "";
  return `---
title: "${(meta.title || topic.title_hint).replace(/"/g, '\\"')}"
slug: "${slug}"
meta_description: "${(meta.meta_description || "").replace(/"/g, '\\"')}"
primary_keyword: "${topic.primary_keyword}"
secondary_keywords: ${JSON.stringify(topic.secondary_keywords || [])}
type: "${topic.type}"
${streamLine}topic_id: "${topic.id}"
${canonicalLine}image_prompt: "${(meta.image_prompt || "").replace(/"/g, '\\"')}"
${imageBlock}internal_link_count: ${internalLinkCount}
generation_cost_cents: ${costCents}
${complianceLine}status: "${status || "pending_review"}"
---

`;
}

export async function generateOne(siteSlug) {
  const site = loadSite(siteSlug);
  const topics = readTopics(site);
  const topic = pickNextTopic(topics);
  if (!topic) {
    console.log(`[${siteSlug}] no queued topics`);
    return null;
  }

  console.log(`[${siteSlug}] generating: ${topic.title_hint}`);

  const internalLinks = await fetchSitemapUrls(site.config.site_url);
  const systemPrompt = buildSystemPrompt(site, internalLinks);

  let totalCost = 0;

  // Stage 1: outline
  const outline = await stageOutline({ site, topic, systemPrompt });
  totalCost += outline.cost_cents;

  // Stage 2: draft (start a thread the critique + revise will continue)
  const draftInstructionMessages = [];
  const draft = await stageDraft({
    site,
    topic,
    outlineText: outline.text,
    systemPrompt,
  });
  totalCost += draft.cost_cents;

  const threadAfterDraft = [
    {
      role: "user",
      content: `[Draft request — see system prompt and outline above]`,
    },
    draft.assistant_msg,
  ];

  // Stage 3: critique (continues the same thread so the model self-reviews)
  const critique = await stageCritique({
    systemPrompt,
    draftText: draft.text,
    prior: threadAfterDraft,
  });
  totalCost += critique.cost_cents;

  // Stage 4: revise
  const threadAfterCritique = [
    ...threadAfterDraft,
    { role: "user", content: "Run your hard-rule critique now." },
    critique.assistant_msg,
  ];
  const revised = await stageRevise({
    systemPrompt,
    critiqueText: critique.text,
    prior: threadAfterCritique,
  });
  totalCost += revised.cost_cents;

  let finalText = revised.text;

  // Compliance rescue: if the revised draft trips blocking patterns, run ONE
  // extra rewrite with the violations fed back. If it still fails, we'll fall
  // through to pending_review and email the approval link.
  let preCheck = checkCompliance(finalText, site);
  let rescued = false;
  if (preCheck.enabled && preCheck.blocking.length > 0) {
    console.log(
      `[${siteSlug}] compliance rescue pass — initial violations: ${summarizeCompliance(preCheck)}`
    );
    const threadAfterRevise = [
      ...threadAfterCritique,
      { role: "user", content: "Output the FINAL revised article now." },
      revised.assistant_msg,
    ];
    try {
      const rescue = await stageRescue({
        systemPrompt,
        blockingList: preCheck.blocking,
        prior: threadAfterRevise,
      });
      totalCost += rescue.cost_cents;
      const rescuedText = rescue.text;
      const rescuedCheck = checkCompliance(rescuedText, site);
      // Only adopt the rescue if it actually reduces blocking violations.
      if (rescuedCheck.blocking.length < preCheck.blocking.length) {
        finalText = rescuedText;
        rescued = true;
        console.log(
          `[${siteSlug}] rescue applied — blocking ${preCheck.blocking.length} → ${rescuedCheck.blocking.length}`
        );
      } else {
        console.log(`[${siteSlug}] rescue produced no improvement, keeping original revise`);
      }
    } catch (e) {
      console.error(`[${siteSlug}] rescue pass failed:`, e.message);
    }
  }

  const wc = wordCount(finalText);

  // Meta
  const meta = await stageMeta({ systemPrompt, finalText, topic });
  totalCost += meta.cost_cents;

  const slug = (meta.parsed.slug || slugify(meta.parsed.title || topic.title_hint)).slice(0, 80);
  const filename = `${topic.id}-${slug}.md`;

  // Compliance check (per-site, configured via config.json -> compliance).
  // Runs on the final text (post-rescue, if a rescue happened).
  //
  // Policy: blocking violations that survive the rescue pass route to
  // pending_review (NOT compliance_failed) so the email approval link reaches a
  // human. We never silently drop a draft to needs-rework after rescue.
  const compliance = checkCompliance(finalText, site);
  const complianceStillBlocking = compliance.enabled && compliance.blocking.length > 0;
  const complianceFailed = false; // legacy bucket, no longer used
  const complianceFlagged =
    compliance.enabled && (compliance.flags.length > 0 || complianceStillBlocking);

  const draftDir = complianceFailed
    ? path.join(site.draftsDir, "needs-rework")
    : site.draftsDir;
  fs.mkdirSync(draftDir, { recursive: true });
  const draftPath = path.join(draftDir, filename);

  // Image generation (skipped on compliance failure to avoid wasting spend)
  let image = null;
  if (!complianceFailed && process.env.REPLICATE_API_TOKEN && meta.parsed.image_prompt) {
    try {
      const imagesDir = path.join(draftDir, "images");
      const imageFile = `${slug}.png`;
      const imageAbsPath = path.join(imagesDir, imageFile);
      const result = await generateImage({
        prompt: meta.parsed.image_prompt,
        outPath: imageAbsPath,
      });
      totalCost += result.costCents;
      image = {
        absPath: imageAbsPath,
        relativePath: `images/${imageFile}`,
        alt: imageAltFromPrompt(meta.parsed.image_prompt, meta.parsed.title || topic.title_hint),
      };
      console.log(`[${siteSlug}] image generated: ${imageAbsPath} (${(result.sizeBytes / 1024).toFixed(0)}kb)`);
    } catch (e) {
      console.error(`[${siteSlug}] image generation failed: ${e.message}`);
      await notify(`⚠️ Image generation failed for ${siteSlug} draft: ${e.message}`);
    }
  }

  const internalLinkCount = (finalText.match(new RegExp(`\\]\\(https?://[^)]*${site.config.site_domain.replace(/\./g, "\\.")}`, "g")) || []).length;

  // AUTO_APPROVE=true (default): skip human review, route clean drafts straight to "approved"
  // so the hourly publish cron commits them. Compliance-flagged drafts still go to pending_review
  // for safety; only blocking failures stay in compliance_failed.
  const autoApprove = (process.env.AUTO_APPROVE || "true").toLowerCase() !== "false";
  const status = complianceFailed
    ? "compliance_failed"
    : complianceFlagged
    ? "pending_review"
    : autoApprove
    ? "approved"
    : "pending_review";
  const frontmatter = buildFrontmatter({
    meta: meta.parsed,
    topic,
    internalLinkCount,
    costCents: totalCost,
    compliance,
    status,
    image,
    site,
  });

  fs.writeFileSync(draftPath, frontmatter + finalText + "\n");

  // Insert / update DB
  const existing = getArticleBySlug(siteSlug, slug);
  let articleId;
  if (existing) {
    updateArticle(existing.id, {
      title: meta.parsed.title || topic.title_hint,
      primary_keyword: topic.primary_keyword,
      word_count: wc,
      draft_path: draftPath,
      status,
      cost_cents: totalCost,
    });
    articleId = existing.id;
  } else {
    articleId = insertArticle({
      site: siteSlug,
      topic_id: topic.id,
      slug,
      title: meta.parsed.title || topic.title_hint,
      primary_keyword: topic.primary_keyword,
      word_count: wc,
      draft_path: draftPath,
      status,
      cost_cents: totalCost,
    });
  }

  // Mark topic as drafted
  topic.status = "drafted";
  topic.last_draft_id = articleId;
  writeTopics(site, topics);

  const costStr = `$${(totalCost / 100).toFixed(2)}`;
  const emoji = complianceFlagged ? "⚠️" : "📝";
  const statusNote = complianceFlagged
    ? `\nFlags for human review: ${summarizeCompliance(compliance)}`
    : "";
  await notify(
    `${emoji} New ${siteSlug} draft #${articleId}: *${meta.parsed.title || topic.title_hint}* (${wc} words, ${costStr})${statusNote}\nReview: \`npm run review:show ${articleId}\``
  );

  // Email approval link when human review is needed.
  if (status === "pending_review" && emailConfigured()) {
    try {
      await sendApprovalEmail({
        articleId,
        title: meta.parsed.title || topic.title_hint,
        siteSlug,
        wordCount: wc,
        compliance,
        draftPath,
        finalText,
      });
      console.log(`[${siteSlug}] approval email sent for #${articleId}`);
    } catch (e) {
      console.error(`[${siteSlug}] approval email failed for #${articleId}: ${e.message}`);
      await notify(`⚠️ Approval email failed [${siteSlug}] #${articleId}: ${e.message}`);
    }
  }

  console.log(`[${siteSlug}] saved draft #${articleId} → ${draftPath} (${wc} words, ${costStr}) [${status}]`);
  return { articleId, draftPath, wordCount: wc, costCents: totalCost, complianceStatus: status };
}

async function sendApprovalEmail({ articleId, title, siteSlug, wordCount, compliance, draftPath, finalText }) {
  const links = buildLinks(articleId);
  if (!links) throw new Error("APPROVAL_BASE_URL not set");
  const complianceSummary = compliance && (compliance.blocking.length || compliance.flags.length)
    ? summarizeCompliance(compliance)
    : "clean";
  const subject = `[autoblog:${siteSlug}] #${articleId} needs review — ${title}`;
  const text = [
    `Draft #${articleId} for ${siteSlug} needs review before it can publish.`,
    ``,
    `Title:    ${title}`,
    `Words:    ${wordCount}`,
    `Compliance: ${complianceSummary}`,
    `File:     ${draftPath}`,
    ``,
    `Approve:  ${links.approve}`,
    `Edit:     ${links.edit}`,
    `Reject:   ${links.reject}`,
    ``,
    `--- DRAFT BODY ---`,
    finalText,
  ].join("\n");
  const safeBody = (finalText || "").replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:760px">
      <p>Draft <strong>#${articleId}</strong> for <strong>${siteSlug}</strong> needs review before it can publish.</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Title</td><td>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Words</td><td>${wordCount}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Compliance</td><td>${complianceSummary.replace(/</g, "&lt;")}</td></tr>
      </table>
      <p style="margin-top:1rem">
        <a href="${links.approve}" style="background:#0a7;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;margin-right:8px">✅ Approve & publish</a>
        <a href="${links.edit}" style="background:#06c;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none;margin-right:8px">✏️ Edit</a>
        <a href="${links.reject}" style="background:#c33;color:#fff;padding:.6rem 1rem;border-radius:6px;text-decoration:none">🗑 Reject</a>
      </p>
      <hr style="margin:1.5rem 0;border:0;border-top:1px solid #ddd">
      <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:#f6f6f6;padding:1rem;border-radius:6px">${safeBody}</pre>
    </div>`;
  await sendEmail({ subject, text, html });
}

// CLI: `node src/generate.js [site-slug]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const slug = process.argv[2];
  if (slug) {
    generateOne(slug).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    const sites = listSites();
    Promise.all(sites.map((s) => generateOne(s).catch((e) => console.error(`[${s}]`, e))));
  }
}
