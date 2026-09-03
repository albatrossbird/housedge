// Re-match a category using persisted LLM claims instead of regex.
//
//   /api/v2/rematch?category=econ                 report only (default)
//   /api/v2/rematch?category=econ&write=1         also write events/outcomes
//   /api/v2/rematch?category=econ&threshold=0.75
//
// Reports the REGEX verdict and the CLAIM verdict for every candidate
// above threshold, side by side. The question this exists to answer is
// "does better extraction find matches the regex gate was missing?",
// and a bare pair count cannot answer it — only the disagreements can.
// `gateDisagreements` is the finding; everything else is context.
//
// Embeddings still do candidate generation (voyage-4-large, carried over
// from v1). Claims decide acceptance. That split is the whole design:
// embeddings are good at "these are about the same thing" and bad at
// "these resolve identically", which is the distinction that matters.

import { selectAll, upsert, credentialInUse } from "../../../lib/v2/db.js";
import { claimsCompatible } from "../../../lib/v2/extract.js";
import { scalarSignaturesCompatible } from "../../../lib/v2/claims.js";
import { cronAuthorized } from "../../../lib/cronAuth.js";

function cosine(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

const vec = e => {
  if (!e) return null;
  if (Array.isArray(e)) return e;
  try { const p = JSON.parse(e); return Array.isArray(p) ? p : null; } catch { return null; }
};

const claimOf = l => l.claim_title_hash ? {
  subject: l.claim_subject, metric_type: l.claim_metric_type,
  unit: l.claim_unit, op: l.claim_op,
  value: l.claim_value == null ? null : Number(l.claim_value),
  low: l.claim_low == null ? null : Number(l.claim_low),
  high: l.claim_high == null ? null : Number(l.claim_high),
  period_year: l.claim_period_year, period_quarter: l.claim_period_quarter,
  period_month: l.claim_period_month, region: l.claim_region,
  confidence: l.claim_confidence == null ? 0 : Number(l.claim_confidence),
} : null;

export default async function handler(req, res) {
  // The v1 job routes have been behind this since they existed; these
  // were not, and they are the more expensive half. /api/v2/extract and
  // /api/v2/extract-eval SPEND ANTHROPIC CREDITS per call, and the repo
  // is public, so the url is too. Inert until CRON_SECRET is set, then
  // closed everywhere at once.
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  const category = req.query.category || "econ";
  const write = req.query.write === "1";
  const threshold = parseFloat(req.query.threshold || "0.78");

  try {
    const { data: listings, error } = await selectAll(
      "listings",
      `category=eq.${encodeURIComponent(category)}&side=eq.yes&select=*`
    );
    if (error) return res.status(500).json({ stage: "read", error });

    const withVec = (listings || []).map(l => ({ ...l, _v: vec(l.embedding) })).filter(l => l._v);
    const kalshi = withVec.filter(l => l.venue_id === "kalshi");
    const poly = withVec.filter(l => l.venue_id === "polymarket");

    const claimed = (listings || []).filter(l => l.claim_title_hash).length;

    const candidates = [];
    for (const k of kalshi) {
      for (const p of poly) {
        const score = cosine(k._v, p._v);
        if (score < threshold) continue;
        const claimVerdict = claimsCompatible(claimOf(k), claimOf(p));
        const regexOk = scalarSignaturesCompatible(k.title, p.title, category);
        candidates.push({ k, p, score, claimVerdict, regexOk });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    // Where the two gates disagree — the actual finding.
    const gateDisagreements = candidates
      .filter(c => c.claimVerdict.compatible !== c.regexOk)
      .map(c => ({
        score: Number(c.score.toFixed(4)),
        kalshi: c.k.title, poly: c.p.title,
        regex: c.regexOk ? "accept" : "reject",
        claim: c.claimVerdict.compatible ? "accept" : "reject",
        claimReason: c.claimVerdict.reason,
        // the extracted values behind the verdict, so a disagreement can
        // be judged rather than taken on trust
        claimK: { subj: c.k.claim_subject, metric: c.k.claim_metric_type, unit: c.k.claim_unit, op: c.k.claim_op, val: c.k.claim_value, y: c.k.claim_period_year, q: c.k.claim_period_quarter, m: c.k.claim_period_month, region: c.k.claim_region, conf: c.k.claim_confidence },
        claimP: { subj: c.p.claim_subject, metric: c.p.claim_metric_type, unit: c.p.claim_unit, op: c.p.claim_op, val: c.p.claim_value, y: c.p.claim_period_year, q: c.p.claim_period_quarter, m: c.p.claim_period_month, region: c.p.claim_region, conf: c.p.claim_confidence },
      }));

    const accept = (list, pred) => {
      const usedK = new Set(), usedP = new Set(), out = [];
      for (const c of list) {
        if (!pred(c)) continue;
        if (usedK.has(c.k.id) || usedP.has(c.p.id)) continue;
        usedK.add(c.k.id); usedP.add(c.p.id);
        out.push(c);
      }
      return out;
    };

    const claimAccepted = accept(candidates, c => c.claimVerdict.compatible);
    const regexAccepted = accept(candidates, c => c.regexOk);

    const result = {
      category,
      threshold,
      credential: credentialInUse(),
      listings: {
        total: (listings || []).length,
        withEmbedding: withVec.length,
        withClaim: claimed,
        kalshi: kalshi.length,
        polymarket: poly.length,
      },
      candidatesAboveThreshold: candidates.length,
      pairs: { byClaimGate: claimAccepted.length, byRegexGate: regexAccepted.length },
      gateDisagreements: gateDisagreements.slice(0, 40),
      acceptedByClaimGate: claimAccepted.slice(0, 40).map(c => ({
        score: Number(c.score.toFixed(4)),
        kalshi: c.k.title, poly: c.p.title,
        alsoAcceptedByRegex: c.regexOk,
      })),
      wrote: null,
    };

    if (write) {
      const now = new Date().toISOString();
      const events = claimAccepted.map(c => ({
        source_key: `claim:${c.k.id}`,
        category,
        subject: c.k.claim_subject || `${category}:unknown`,
        title: String(c.k.title || "").split("—")[0].trim(),
        period_year: c.k.claim_period_year ?? null,
        period_quarter: c.k.claim_period_quarter ?? null,
        region: c.k.claim_region ?? null,
        outcomes_exhaustive: true,
      }));

      const evUp = await upsert("events", events, "source_key", { returning: true });
      if (evUp.errors.length) return res.status(500).json({ stage: "events", errors: evUp.errors.slice(0, 3), ...result });
      const evBy = new Map(evUp.rows.map(e => [e.source_key, e]));

      const outcomeRows = [];
      for (const c of claimAccepted) {
        const ev = evBy.get(`claim:${c.k.id}`);
        if (!ev) continue;
        outcomeRows.push({
          event_id: ev.id, label: "Yes", sort_order: 0,
          claim_unit: c.k.claim_unit ?? null,
          claim_op: c.k.claim_op ?? null,
          claim_value: c.k.claim_value ?? null,
          claim_low: c.k.claim_low ?? null,
          claim_high: c.k.claim_high ?? null,
        });
        outcomeRows.push({ event_id: ev.id, label: "No", sort_order: 1 });
      }
      const outUp = await upsert("outcomes", outcomeRows, "event_id,label", { returning: true });
      if (outUp.errors.length) return res.status(500).json({ stage: "outcomes", errors: outUp.errors.slice(0, 3), ...result });
      const outBy = new Map(outUp.rows.map(o => [`${o.event_id}|${o.label}`, o]));

      // Attach both sides of both venues' listings to the right outcome.
      const { data: allSides } = await selectAll(
        "listings",
        `category=eq.${encodeURIComponent(category)}&select=id,venue_id,venue_market_id,side,title`
      );
      const sideIdx = new Map();
      for (const l of allSides || []) sideIdx.set(`${l.venue_id}|${l.venue_market_id}|${l.side}`, l);

      const listingUpdates = [];
      for (const c of claimAccepted) {
        const ev = evBy.get(`claim:${c.k.id}`);
        if (!ev) continue;
        const yes = outBy.get(`${ev.id}|Yes`), no = outBy.get(`${ev.id}|No`);
        for (const base of [c.k, c.p]) {
          for (const [side, outcome] of [["yes", yes], ["no", no]]) {
            const l = sideIdx.get(`${base.venue_id}|${base.venue_market_id}|${side}`);
            if (!l || !outcome) continue;
            listingUpdates.push({
              id: l.id,
              outcome_id: outcome.id,
              match_method: "llm-claim",
              match_confidence: Number(c.score.toFixed(4)),
              match_decided_at: now,
            });
          }
        }
      }
      const lUp = await upsert("listings", listingUpdates, "id");

      result.wrote = {
        events: evUp.count,
        outcomes: outUp.count,
        listingsAttached: lUp.count,
        errors: lUp.errors.slice(0, 3),
      };
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
  }
}
