// Extract resolution claims for stored listings and persist them.
//
//   /api/v2/extract?category=econ&limit=200        write
//   /api/v2/extract?category=econ&dry=1            preview: what needs work, est. cost
//   /api/v2/extract?category=econ&force=1          re-extract even if hash matches
//   /api/v2/extract?model=claude-opus-5            override model
//
// RESUMABLE BY DESIGN. Only listings whose title hash differs from
// claim_title_hash are candidates, so this can be called repeatedly
// until `remaining` is 0 and each call is bounded. That matters twice
// over: Vercel functions time out well before 1,283 titles finish, and
// a cron re-running this should cost ~nothing when nothing changed.
//
// Model default is claude-haiku-4-5 — chosen by measurement, not
// assumption. It matched Sonnet 5 and Opus 5 on every axis the bake-off
// could measure at ~1/6 the cost. See docs/extraction-model-eval.md,
// including the caveat that the eval saturated.

import crypto from "crypto";
import { selectAll, patchWhere, credentialInUse } from "../../../lib/v2/db.js";
import { extractClaims, costOf } from "../../../lib/v2/extract.js";
import { cronAuthorized } from "../../../lib/cronAuth.js";

const DEFAULT_MODEL = "claude-haiku-4-5";

export function titleHash(title, model) {
  return crypto.createHash("sha256").update(`${model}::${title}`).digest("hex").slice(0, 32);
}

export default async function handler(req, res) {
  // The v1 job routes have been behind this since they existed; these
  // were not, and they are the more expensive half. /api/v2/extract and
  // /api/v2/extract-eval SPEND ANTHROPIC CREDITS per call, and the repo
  // is public, so the url is too. Inert until CRON_SECRET is set, then
  // closed everywhere at once.
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  const dry = req.query.dry === "1";
  const force = req.query.force === "1";
  const category = req.query.category || null;
  const model = req.query.model || DEFAULT_MODEL;
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 600);

  if (!dry && !process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: "ANTHROPIC_API_KEY not set",
      remedy: "Add it in Vercel > Settings > Environment Variables, then redeploy.",
    });
  }

  try {
    const filter = category ? `category=eq.${encodeURIComponent(category)}&` : "";
    const { data: listings, error } = await selectAll(
      "listings",
      `${filter}select=id,title,category,venue_id,side,claim_title_hash`
    );
    if (error) return res.status(500).json({ stage: "read listings", error });

    // Both sides of a venue market share a title, and the two venues
    // often repeat titles across categories — extract once per DISTINCT
    // title and fan the result out to every listing that shares it.
    // This is where most of the saving is: 2,566 listings collapse to
    // roughly half that many distinct titles.
    const byTitle = new Map();
    for (const l of listings || []) {
      if (!l.title) continue;
      const wanted = titleHash(l.title, model);
      if (!force && l.claim_title_hash === wanted) continue;
      if (!byTitle.has(l.title)) byTitle.set(l.title, { listings: [], meta: l });
      byTitle.get(l.title).listings.push(l);
    }

    const distinctTitles = [...byTitle.keys()];
    const batchTitles = distinctTitles.slice(0, limit);

    if (dry) {
      return res.status(200).json({
        mode: "dry-run",
        model,
        category: category || "all",
        totalListings: (listings || []).length,
        distinctTitlesNeedingWork: distinctTitles.length,
        wouldProcessThisCall: batchTitles.length,
        // ~$0.51/1k markets measured for haiku-4-5 in the bake-off
        estimatedCostUSD: Number(((batchTitles.length / 1000) * 0.51).toFixed(4)),
        sampleTitles: batchTitles.slice(0, 5),
      });
    }

    if (!batchTitles.length) {
      return res.status(200).json({
        mode: "write", model, category: category || "all",
        extracted: 0, listingsUpdated: 0, remaining: 0,
        note: "Nothing to do — every listing already has a current claim.",
      });
    }

    const input = batchTitles.map(t => {
      const meta = byTitle.get(t).meta;
      return { title: t, category: meta.category, venue: meta.venue_id };
    });

    const run = await extractClaims(input, { model });
    const claimByTitle = new Map(run.claims.map(c => [c.title, c]));

    const now = new Date().toISOString();

    // One PATCH per distinct title, setting the claim on every listing
    // that shares it (both sides of a binary market). Deliberately not
    // an upsert — see patchWhere() for why a partial upsert fails here,
    // and why sending full rows is the wrong workaround on a table
    // holding embeddings.
    let listingsUpdated = 0;
    const writeErrors = [];
    const CONC = 8;
    const work = batchTitles.filter(t => claimByTitle.has(t));

    for (let i = 0; i < work.length; i += CONC) {
      const slice = work.slice(i, i + CONC);
      const settled = await Promise.all(slice.map(async t => {
        const c = claimByTitle.get(t);
        const ids = byTitle.get(t).listings.map(l => l.id);
        const filter = `id=in.(${ids.map(id => `"${id}"`).join(",")})`;
        const { error } = await patchWhere("listings", filter, {
          claim_subject: c.subject ?? null,
          claim_metric_type: c.metric_type ?? null,
          claim_unit: c.unit ?? null,
          claim_op: c.op ?? null,
          claim_value: c.value ?? null,
          claim_low: c.low ?? null,
          claim_high: c.high ?? null,
          claim_period_year: c.period_year ?? null,
          claim_period_quarter: c.period_quarter ?? null,
          claim_period_month: c.period_month ?? null,
          claim_region: c.region ?? null,
          claim_side: c.side ?? null,
          claim_confidence: c.confidence ?? null,
          claim_model: model,
          claim_extracted_at: now,
          claim_title_hash: titleHash(t, model),
        });
        return { error, n: ids.length };
      }));
      for (const r of settled) {
        if (r.error) writeErrors.push(JSON.stringify(r.error));
        else listingsUpdated += r.n;
      }
    }

    res.status(200).json({
      mode: "write",
      model,
      credential: credentialInUse(),
      category: category || "all",
      distinctTitlesProcessed: batchTitles.length,
      claimsReturned: run.claims.length,
      listingsUpdated,
      remaining: Math.max(0, distinctTitles.length - batchTitles.length),
      costUSD: Number((run.cost || 0).toFixed(5)),
      usage: run.usage,
      errors: [...run.errors, ...writeErrors].slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
  }
}
