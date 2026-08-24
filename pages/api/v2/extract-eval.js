// Model bake-off for LLM claim extraction.
//
//   /api/v2/extract-eval?limit=100
//   /api/v2/extract-eval?limit=300&models=claude-haiku-4-5,claude-sonnet-5,claude-opus-5
//   /api/v2/extract-eval?pairsonly=1     decision test only (cheap, ~30 titles)
//
// Measures three things per model, on real data from `listings`:
//
//  1. DECISION ACCURACY on the labeled pair set (lib/v2/eval-cases.js) —
//     the cases the regex gate actually got wrong during this project's
//     audits. This is the number that matters: extraction is only a
//     means to a correct accept/reject.
//
//  2. COVERAGE vs the regex baseline — how often each produces a usable
//     claim. Regex returning null on a title it doesn't recognize is
//     the gap an LLM is supposed to close, so "extracted where regex
//     could not" is the value-add metric.
//
//  3. ACTUAL COST from reported token usage, not an estimate.
//
// Requires ANTHROPIC_API_KEY in the environment.

import { selectAll } from "../../../lib/v2/db.js";
import { extractClaims, claimsCompatible, costOf } from "../../../lib/v2/extract.js";
import { extractNumericClaim, extractPeriod } from "../../../lib/v2/claims.js";
import { PAIR_CASES } from "../../../lib/v2/eval-cases.js";

const DEFAULT_MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];

export default async function handler(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: "ANTHROPIC_API_KEY not set",
      remedy:
        "Add it in Vercel > Settings > Environment Variables, then redeploy — Vercel only exposes a var to deployments built after it is added.",
    });
  }

  const models = (req.query.models || DEFAULT_MODELS.join(",")).split(",").map(s => s.trim());
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const pairsOnly = req.query.pairsonly === "1";

  try {
    // ── 1. decision test on labeled pairs ───────────────────────
    // Extract every distinct title once per model, then evaluate each
    // labeled pair against those claims.
    const pairTitles = [];
    const titleIndex = new Map();
    for (const c of PAIR_CASES) {
      for (const [side, title] of [["kalshi", c.kalshi], ["poly", c.poly]]) {
        if (!titleIndex.has(title)) {
          titleIndex.set(title, pairTitles.length);
          pairTitles.push({ title, venue: side === "kalshi" ? "kalshi" : "polymarket", category: "econ" });
        }
      }
    }

    // ── 2. coverage sample from real stored listings ────────────
    let sample = [];
    if (!pairsOnly) {
      const { data: listings } = await selectAll(
        "listings",
        "select=title,category,venue_id&side=eq.yes"
      );
      // spread across categories so the sample isn't all one shape
      const byCat = new Map();
      for (const l of listings || []) {
        if (!l.title) continue;
        const k = l.category || "unknown";
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k).push(l);
      }
      const cats = [...byCat.keys()];
      let i = 0;
      while (sample.length < limit && cats.some(c => byCat.get(c).length)) {
        const c = cats[i++ % cats.length];
        const next = byCat.get(c).shift();
        if (next) sample.push({ title: next.title, category: c, venue: next.venue_id });
      }
    }

    const results = {};

    for (const model of models) {
      const modelStart = Date.now();

      const pairRun = await extractClaims(pairTitles, { model });
      const claimByTitle = new Map(pairRun.claims.map(c => [c.title, c]));

      let correct = 0;
      const decisions = [];
      for (const c of PAIR_CASES) {
        const verdict = claimsCompatible(claimByTitle.get(c.kalshi), claimByTitle.get(c.poly));
        const got = verdict.compatible ? "accept" : "reject";
        const ok = got === c.expect;
        if (ok) correct++;
        decisions.push({
          id: c.id, observed: c.observed, expect: c.expect, got, ok,
          reason: verdict.reason,
        });
      }

      let coverage = null;
      let sampleRun = { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }, cost: 0, errors: [], claims: [] };

      if (!pairsOnly && sample.length) {
        sampleRun = await extractClaims(sample, { model });
        let llmOnly = 0, both = 0, regexOnly = 0, neither = 0, disagreeValue = 0;
        for (const s of sample) {
          const rx = extractNumericClaim(s.title);
          const llm = sampleRun.claims.find(c => c.title === s.title);
          const llmHas = llm && llm.confidence >= 0.5 && llm.op != null;
          if (llmHas && rx) {
            both++;
            if (rx.value != null && llm.value != null && Math.abs(rx.value - llm.value) >= 0.05) disagreeValue++;
          } else if (llmHas) llmOnly++;
          else if (rx) regexOnly++;
          else neither++;
        }
        coverage = {
          sampled: sample.length,
          bothExtracted: both,
          llmOnly,          // the gap an LLM is meant to close
          regexOnly,        // regression risk — regex saw something the LLM missed
          neither,
          valueDisagreements: disagreeValue,
          regionsPopulated: sampleRun.claims.filter(c => c.region).length,
          avgConfidence: sampleRun.claims.length
            ? Number((sampleRun.claims.reduce((a, c) => a + (c.confidence || 0), 0) / sampleRun.claims.length).toFixed(3))
            : null,
        };
      }

      const usage = {
        input_tokens: pairRun.usage.input_tokens + sampleRun.usage.input_tokens,
        output_tokens: pairRun.usage.output_tokens + sampleRun.usage.output_tokens,
        cache_read_input_tokens:
          pairRun.usage.cache_read_input_tokens + sampleRun.usage.cache_read_input_tokens,
      };
      const totalCost = costOf(model, usage);
      const marketsProcessed = pairTitles.length + sample.length;

      results[model] = {
        decisionAccuracy: `${correct}/${PAIR_CASES.length}`,
        decisionPct: Number(((correct / PAIR_CASES.length) * 100).toFixed(1)),
        failures: decisions.filter(d => !d.ok),
        coverage,
        cost: {
          totalUSD: Number(totalCost.toFixed(5)),
          perMarketUSD: Number((totalCost / marketsProcessed).toFixed(6)),
          per1kMarketsUSD: Number(((totalCost / marketsProcessed) * 1000).toFixed(3)),
          usage,
        },
        elapsedMs: Date.now() - modelStart,
        errors: [...pairRun.errors, ...sampleRun.errors].slice(0, 3),
      };
    }

    res.status(200).json({
      pairCases: {
        total: PAIR_CASES.length,
        observed: PAIR_CASES.filter(c => c.observed).length,
        constructed: PAIR_CASES.filter(c => !c.observed).length,
        expectAccept: PAIR_CASES.filter(c => c.expect === "accept").length,
        expectReject: PAIR_CASES.filter(c => c.expect === "reject").length,
      },
      coverageSampleSize: sample.length,
      results,
      note: "Regex baseline for comparison: it passes the observed reject cases only after four rounds of targeted patching (adjective country forms, bps, central-bank names, less-than-or-equal). A model scoring similarly is doing so without that hand-tuning, which is the actual comparison.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
  }
}
