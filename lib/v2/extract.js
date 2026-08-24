// LLM structured extraction of resolution claims from market titles.
//
// This is the "normalize" stage from docs/architecture-v2.md — the
// replacement for per-category regex. The regex extractors in
// lib/v2/claims.js took four rounds of patching for ONE category
// (missing "Japanese" because \bjapan\b has no boundary before "ese",
// missing bps entirely, missing ECB/BOE which name no country), and
// that cost repeats for every new category and venue. An LLM reads the
// claim instead of pattern-matching phrasings.
//
// The schema below is not invented — it is exactly the set of fields
// that turned out to decide matches during this project's audits:
// unit, comparator, value, period, region. The regex work defined it.

import Anthropic from "@anthropic-ai/sdk";

export const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "The index of the market this result is for, from the input list.",
          },
          subject: {
            type: "string",
            description:
              "Normalized underlying being measured, lowercase snake_case, no threshold or date. E.g. 'us_real_gdp_growth_qoq', 'us_cpi_mom', 'fed_funds_rate_upper_bound', 'mlb_game_winner'.",
          },
          metric_type: {
            type: "string",
            enum: ["level", "change", "count", "winner", "occurrence", "ordinal", "unknown"],
            description:
              "'level' = a value of a measure (rate is 3.5%). 'change' = a movement (rate rises 25bps). 'count' = how many times something happens (5 rate hikes). 'winner' = which competitor wins. 'occurrence' = whether an event happens at all.",
          },
          unit: {
            type: ["string", "null"],
            enum: ["percent", "bps", "count", "usd", "other", null],
            description: "Unit of the numeric claim. null when there is no numeric claim.",
          },
          op: {
            type: ["string", "null"],
            enum: ["gt", "gte", "lt", "lte", "eq", "range", "winner", null],
            description: "Comparator. 'range' when the claim is a bounded bucket.",
          },
          value: { type: ["number", "null"], description: "Threshold for scalar comparators." },
          low: { type: ["number", "null"], description: "Lower bound when op is 'range'." },
          high: { type: ["number", "null"], description: "Upper bound when op is 'range'." },
          period_year: { type: ["integer", "null"] },
          period_quarter: { type: ["integer", "null"], description: "1-4, or null." },
          period_month: { type: ["integer", "null"], description: "1-12, or null." },
          region: {
            type: ["string", "null"],
            description:
              "ISO-ish region of the underlying: 'US', 'UK', 'EU', 'JP', 'DE', 'MX', 'CN', 'WORLD', etc. Infer from the issuing institution when no country is named — an ECB question is 'EU', a Bank of England question is 'UK'. Use null only when genuinely not region-specific.",
          },
          side: {
            type: ["string", "null"],
            description:
              "For 'winner' markets, which competitor this market pays out on. Null otherwise.",
          },
          confidence: {
            type: "number",
            description: "0-1. Below 0.5 means the title was too ambiguous to parse reliably.",
          },
        },
        required: [
          "index", "subject", "metric_type", "unit", "op", "value", "low", "high",
          "period_year", "period_quarter", "period_month", "region", "side", "confidence",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const SYSTEM = `You extract structured resolution claims from prediction-market titles.

Two markets are THE SAME market only if they resolve identically on the same underlying. Your output is used to decide that, so precision on these fields matters more than filling them in:

- unit: a rate LEVEL question ("fed funds rate above 4.25%") and a rate CHANGE question ("25 bps increase") and a COUNT question ("5 or more rate hikes") are three different things that are often correlated. Never collapse them.
- region: many venues list the same threshold for different countries. Kalshi's economics markets are US-only and usually do not say "US" — infer US when the title names a US institution (Federal Reserve, BLS, BEA) or no region at all in a US-listing context. Infer the region from the institution when no country is named: ECB -> EU, Bank of England -> UK, Bank of Japan -> JP.
- period: a Q3 2026 question and a full-year 2026 question are different, as are September and October.
- value: "above 3.0%" and "above 3.5%" are different markets. Do not round.

Set confidence below 0.5 rather than guessing when a title is genuinely ambiguous. A low-confidence honest answer is more useful than a confident wrong one — downstream logic only blocks a match on a *confident* disagreement.`;

export const MODEL_PRICING = {
  "claude-opus-5":   { input: 5.0,  output: 25.0 },
  "claude-sonnet-5": { input: 3.0,  output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

export function costOf(model, usage) {
  const p = MODEL_PRICING[model];
  if (!p || !usage) return null;
  const inTok = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (inTok * p.input + (usage.output_tokens || 0) * p.output) / 1_000_000;
}

/**
 * Extract claims for a batch of markets.
 * @param {Array<{title:string, category?:string, venue?:string}>} markets
 */
export async function extractClaims(markets, { model = "claude-opus-5", batchSize = 25 } = {}) {
  const client = new Anthropic();
  const out = [];
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const errors = [];

  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    const listing = batch
      .map((m, j) => `${j}. [${m.venue || "?"}/${m.category || "?"}] ${m.title}`)
      .join("\n");

    try {
      const res = await client.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `Extract a claim for each market. Return one result per input, with matching index.\n\n${listing}`,
          },
        ],
        output_config: { format: { type: "json_schema", schema: CLAIM_SCHEMA } },
      });

      usageTotals.input_tokens += res.usage?.input_tokens || 0;
      usageTotals.output_tokens += res.usage?.output_tokens || 0;
      usageTotals.cache_read_input_tokens += res.usage?.cache_read_input_tokens || 0;

      const text = res.content.find(b => b.type === "text")?.text || "{}";
      const parsed = res.parsed_output ?? JSON.parse(text);

      for (const r of parsed.results || []) {
        const src = batch[r.index];
        if (src) out.push({ ...r, title: src.title, _globalIndex: i + r.index });
      }
    } catch (err) {
      errors.push(`batch ${i}: ${err.name}: ${err.message}`);
    }
  }

  return { claims: out, usage: usageTotals, cost: costOf(model, usageTotals), errors };
}

// ── Compatibility over extracted claims ──────────────────────────
// Same asymmetry rule as the regex gate: only a CONFIDENT disagreement
// blocks a match. Missing or low-confidence data must never manufacture
// a rejection, or coverage silently collapses wherever extraction is
// weak — which would look like "the model is bad" when it is actually
// "the model was honest about not knowing".
const EPS = 0.05;

export function claimsCompatible(a, b, { minConfidence = 0.5 } = {}) {
  if (!a || !b) return { compatible: true, reason: "missing claim" };
  if (a.confidence < minConfidence || b.confidence < minConfidence) {
    return { compatible: true, reason: "low confidence — not blocking" };
  }

  if (a.region && b.region && a.region !== b.region) {
    return { compatible: false, reason: `region ${a.region} vs ${b.region}` };
  }
  if (a.unit && b.unit && a.unit !== b.unit) {
    return { compatible: false, reason: `unit ${a.unit} vs ${b.unit}` };
  }
  if (a.metric_type !== "unknown" && b.metric_type !== "unknown" && a.metric_type !== b.metric_type) {
    return { compatible: false, reason: `metric ${a.metric_type} vs ${b.metric_type}` };
  }
  if (a.period_year && b.period_year && a.period_year !== b.period_year) {
    return { compatible: false, reason: `year ${a.period_year} vs ${b.period_year}` };
  }
  if (a.period_quarter && b.period_quarter && a.period_quarter !== b.period_quarter) {
    return { compatible: false, reason: `quarter Q${a.period_quarter} vs Q${b.period_quarter}` };
  }
  if (a.period_month && b.period_month && a.period_month !== b.period_month) {
    return { compatible: false, reason: `month ${a.period_month} vs ${b.period_month}` };
  }

  const grp = op => (op === "gt" || op === "gte") ? "gte" : (op === "lt" || op === "lte") ? "lte" : op;
  if (a.op && b.op) {
    if (a.op === "range" || b.op === "range") {
      if (a.op !== b.op) return { compatible: false, reason: "range vs scalar" };
      if (Math.abs((a.low ?? 0) - (b.low ?? 0)) >= EPS || Math.abs((a.high ?? 0) - (b.high ?? 0)) >= EPS) {
        return { compatible: false, reason: `range ${a.low}-${a.high} vs ${b.low}-${b.high}` };
      }
    } else {
      if (grp(a.op) !== grp(b.op)) return { compatible: false, reason: `op ${a.op} vs ${b.op}` };
      if (a.value != null && b.value != null && Math.abs(a.value - b.value) >= EPS) {
        return { compatible: false, reason: `value ${a.value} vs ${b.value}` };
      }
    }
  }

  return { compatible: true, reason: "compatible" };
}
