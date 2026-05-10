// Per-site compliance check. Configured via sites/<slug>/config.json -> "compliance".
// Runs on the final revised draft text before save. Returns { blocking, flags }.
//
//  - "forbidden_patterns": regex strings. ANY match -> blocking failure (draft routed to drafts/needs-rework/).
//  - "disclaimer_required_when_mentions" + "required_disclaimer": if any of the trigger strings
//    appears in the article AND the required_disclaimer substring is absent, that's a blocking failure.
//  - "flag_for_human": regex strings whose matches surface as warnings (don't block, but get listed
//    in the draft frontmatter and the Slack message so the human reviewer can verify).

// A match is "in a denial context" if the surrounding window contains a clear
// negation. This lets Stream A articles legitimately quote the FDA disclaimer
// ("not intended to ... cure ...") and discuss "not FDA approved" without
// tripping the gate. We check a window of 40 chars BEFORE the match (and 80
// chars after, for the "do not claim cures" pattern where the negation precedes
// the verb that precedes the forbidden noun).
const NEGATION_TOKENS = [
  /\bnot\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bwithout\b/i,
  /\bdoesn'?t\b/i,
  /\bdon'?t\b/i,
  /\bisn'?t\b/i,
  /\baren'?t\b/i,
  /\bwon'?t\b/i,
  /\bcannot\b/i,
  /\bcan'?t\b/i,
  /\bnone\b/i,
  /\bnor\b/i,
  /\b(?:do|does|did)\s+not\b/i,
  /\bnot\s+intended\s+to\b/i,
  /\bnot\s+(?:FDA|approved)\b/i,
];

function isInDenialContext(text, matchIndex, matchLength) {
  const windowStart = Math.max(0, matchIndex - 60);
  const windowEnd = Math.min(text.length, matchIndex + matchLength + 30);
  const window = text.slice(windowStart, windowEnd);
  return NEGATION_TOKENS.some((re) => re.test(window));
}

export function checkCompliance(text, site) {
  const cfg = site?.config?.compliance;
  if (!cfg || cfg.enabled === false) {
    return { enabled: false, blocking: [], flags: [] };
  }

  const blocking = [];
  const flags = [];

  // Forbidden regex patterns. Skip matches in denial context (negated claims).
  for (const pattern of cfg.forbidden_patterns || []) {
    let re;
    try {
      re = new RegExp(pattern, "ig");
    } catch (e) {
      blocking.push({ rule: "forbidden_patterns", pattern, error: `bad regex: ${e.message}` });
      continue;
    }
    let firstClaimMatch = null;
    for (const m of text.matchAll(re)) {
      if (isInDenialContext(text, m.index, m[0].length)) continue;
      firstClaimMatch = m;
      break;
    }
    if (firstClaimMatch) {
      blocking.push({ rule: "forbidden_patterns", pattern, match: firstClaimMatch[0].slice(0, 80) });
    }
  }

  // Disclaimer requirement (uses ORIGINAL text — the disclaimer should literally be present)
  const triggers = cfg.disclaimer_required_when_mentions || [];
  const required = cfg.required_disclaimer;
  if (required && triggers.length) {
    const triggered = triggers.some((t) => text.toLowerCase().includes(t.toLowerCase()));
    const present = text.toLowerCase().includes(required.toLowerCase());
    if (triggered && !present) {
      blocking.push({
        rule: "required_disclaimer_missing",
        required: required.slice(0, 80),
        note: `article mentions ${triggers.find((t) => text.toLowerCase().includes(t.toLowerCase()))} but does not include the required disclaimer text.`,
      });
    }
  }

  // Human-review flags
  for (const pattern of cfg.flag_for_human || []) {
    let re;
    try {
      re = new RegExp(pattern, "ig");
    } catch (e) {
      flags.push({ rule: "flag_for_human", pattern, error: `bad regex: ${e.message}` });
      continue;
    }
    const matches = [...text.matchAll(re)];
    if (matches.length) {
      flags.push({
        rule: "flag_for_human",
        pattern,
        count: matches.length,
        sample: matches[0][0].slice(0, 80),
      });
    }
  }

  return { enabled: true, blocking, flags };
}

export function summarizeCompliance(result) {
  if (!result.enabled) return "compliance: not configured";
  const parts = [];
  if (result.blocking.length === 0 && result.flags.length === 0) {
    return "compliance: clean";
  }
  if (result.blocking.length) {
    parts.push(
      `BLOCKING (${result.blocking.length}): ` +
        result.blocking
          .map((b) => `${b.rule}${b.pattern ? `[${b.pattern}]` : ""}${b.match ? ` -> "${b.match}"` : ""}${b.note ? ` -> ${b.note}` : ""}`)
          .join("; ")
    );
  }
  if (result.flags.length) {
    parts.push(
      `FLAGS (${result.flags.length}): ` +
        result.flags.map((f) => `${f.pattern} (×${f.count}) e.g. "${f.sample}"`).join("; ")
    );
  }
  return parts.join(" | ");
}
