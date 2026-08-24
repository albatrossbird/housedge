// Backfill the v2 schema from v1 `markets` + `pairs`.
//
//   /api/v2/backfill?dry=1   preview counts + samples, writes nothing
//   /api/v2/backfill         write
//   /api/v2/backfill?category=econ   scope to one category
//
// This is additive and idempotent: v1 tables are only read, and every
// v2 row has a deterministic natural key (events.source_key,
// outcomes(event_id,label), listings(venue_id,venue_market_id,side)) so
// re-running updates in place instead of duplicating.
//
// Mapping decisions worth knowing:
//
// - One v1 pair becomes one event with a Yes/No outcome set. The
//   threshold ("above 3.0%") lives in the *outcome's* claim, not the
//   event, which is a faithful lift of what v1 actually knows.
//   Grouping the ~9 Kalshi GDP buckets under a single event with a
//   bucket outcome set is the better long-term model (it's what makes
//   synthetic combinations derivable) but v1 has no reliable signal for
//   which buckets belong together, and guessing wrong would be worse
//   than waiting for structured extraction.
//
// - Unmatched v1 markets still become listings, with outcome_id NULL.
//   They are not dropped: unmatched is a valid state and those rows are
//   exactly the review-queue backlog.
//
// - v1 stored a single price with no bid/ask, so seeded quotes set
//   `mid` and leave bid/ask NULL rather than inventing a spread.

import { selectAll, upsert, credentialInUse } from "../../../lib/v2/db.js";
import { extractNumericClaim, extractPeriod } from "../../../lib/v2/claims.js";

const SPORTS = new Set(["mlb", "nba", "nhl", "soccer"]);

const isKalshi = id => String(id || "").toUpperCase().startsWith("KX");

// Kalshi titles carry the side after an em dash ("... ? — Above 3.0%").
// The event title is the question; the side belongs to the outcome.
function stripSide(title) {
  return String(title || "").split("—")[0].trim();
}

function slugSubject(title, category) {
  const base = stripSide(title)
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12)
    .join("_");
  return `${category}:${base}` || `${category}:unknown`;
}

function kalshiUrl(id) {
  const series = String(id || "").split("-")[0];
  return series ? `https://kalshi.com/markets/${series.toLowerCase()}` : "https://kalshi.com/";
}

const polyUrl = slug =>
  slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/";

export default async function handler(req, res) {
  const dry = req.query.dry === "1";
  const category = req.query.category || null;

  try {
    const [{ data: markets, error: mErr }, { data: pairs, error: pErr }] = await Promise.all([
      selectAll("markets", "select=*"),
      selectAll("pairs", "select=*"),
    ]);
    if (mErr) return res.status(500).json({ stage: "read markets", error: mErr });
    if (pErr) return res.status(500).json({ stage: "read pairs", error: pErr });

    const byId = new Map((markets || []).map(m => [m.id, m]));

    const scoped = p => {
      const k = byId.get(p.kalshi_id);
      return k && (!category || k.sport_tag === category);
    };
    const usablePairs = (pairs || []).filter(p => scoped(p) && byId.has(p.polymarket_id));

    // ── events ────────────────────────────────────────────────
    const eventRows = usablePairs.map(p => {
      const k = byId.get(p.kalshi_id);
      const period = extractPeriod(k.title) || {};
      return {
        source_key: `v1pair:${p.kalshi_id}`,
        category: k.sport_tag || "unknown",
        subject: slugSubject(k.title, k.sport_tag || "unknown"),
        title: stripSide(k.title),
        period_year: period.year ?? null,
        period_quarter: period.quarter ?? null,
        resolution_date: k.close_time || null,
        // v1's econ gate treats Kalshi econ markets as implicitly US-only
        // and filters foreign ones out, so anything that survived matching
        // is US. Region is meaningless for a ball game.
        region: k.sport_tag === "econ" ? "US" : null,
        // A Yes/No pair is mutually exclusive and exhaustive, so
        // sum-of-asks arb math is valid for these events.
        outcomes_exhaustive: true,
      };
    });

    if (dry) {
      const unmatched = (markets || []).filter(m => {
        if (category && m.sport_tag !== category) return false;
        return !usablePairs.some(p => p.kalshi_id === m.id || p.polymarket_id === m.id);
      });
      return res.status(200).json({
        mode: "dry-run",
        credential: credentialInUse(),
        category: category || "all",
        v1: { markets: (markets || []).length, pairs: (pairs || []).length },
        wouldWrite: {
          events: eventRows.length,
          outcomes: eventRows.length * 2,
          listingsFromPairs: usablePairs.length * 4,
          listingsUnmatched: unmatched.length * 2,
          quotes: usablePairs.length * 4 + unmatched.length * 2,
        },
        sampleEvents: eventRows.slice(0, 3),
        sampleUnmatchedTitles: unmatched.slice(0, 5).map(m => m.title),
      });
    }

    const evUp = await upsert("events", eventRows, "source_key", { returning: true });
    if (evUp.errors.length) {
      return res.status(500).json({ stage: "events", errors: evUp.errors.slice(0, 3) });
    }
    const eventBySourceKey = new Map(evUp.rows.map(e => [e.source_key, e]));

    // ── outcomes (Yes / No per event) ─────────────────────────
    const outcomeRows = [];
    for (const p of usablePairs) {
      const ev = eventBySourceKey.get(`v1pair:${p.kalshi_id}`);
      if (!ev) continue;
      const k = byId.get(p.kalshi_id);
      const c = extractNumericClaim(k.title);
      outcomeRows.push({
        event_id: ev.id,
        label: "Yes",
        claim_unit: c?.unit ?? null,
        claim_op: c?.op ?? null,
        claim_value: c?.value ?? null,
        claim_low: c?.low ?? null,
        claim_high: c?.high ?? null,
        sort_order: 0,
      });
      // "No" is the negation of the same claim; storing an inverted
      // comparator would be a guess (the complement of "above 3.0%" is
      // "3.0% or below", but only if the claim was extracted correctly),
      // so leave it unstructured rather than assert something wrong.
      outcomeRows.push({
        event_id: ev.id, label: "No",
        claim_unit: null, claim_op: null, claim_value: null,
        claim_low: null, claim_high: null, sort_order: 1,
      });
    }

    const outUp = await upsert("outcomes", outcomeRows, "event_id,label", { returning: true });
    if (outUp.errors.length) {
      return res.status(500).json({ stage: "outcomes", errors: outUp.errors.slice(0, 3) });
    }
    const outcomeKey = (eventId, label) => `${eventId}|${label}`;
    const outcomeMap = new Map(outUp.rows.map(o => [outcomeKey(o.event_id, o.label), o]));

    // ── listings ──────────────────────────────────────────────
    const listingRows = [];
    const seen = new Set();

    const pushListing = (m, side, outcomeId) => {
      const venue = isKalshi(m.id) ? "kalshi" : "polymarket";
      const key = `${venue}|${m.id}|${side}`;
      if (seen.has(key)) return;
      seen.add(key);
      listingRows.push({
        venue_id: venue,
        venue_market_id: String(m.id),
        side,
        outcome_id: outcomeId,
        title: m.title || "",
        side_label: m.side_label || null,
        url: venue === "kalshi" ? kalshiUrl(m.id) : polyUrl(m.slug),
        category: m.sport_tag || null,
        status: "open",
        embedding: m.embedding ? JSON.parse(m.embedding) : null,
        match_method: outcomeId ? "v1-backfill" : null,
        match_confidence: null,
        match_decided_at: outcomeId ? new Date().toISOString() : null,
        last_seen: new Date().toISOString(),
      });
    };

    for (const p of usablePairs) {
      const ev = eventBySourceKey.get(`v1pair:${p.kalshi_id}`);
      if (!ev) continue;
      const yes = outcomeMap.get(outcomeKey(ev.id, "Yes"));
      const no = outcomeMap.get(outcomeKey(ev.id, "No"));
      for (const m of [byId.get(p.kalshi_id), byId.get(p.polymarket_id)]) {
        pushListing(m, "yes", yes?.id ?? null);
        pushListing(m, "no", no?.id ?? null);
      }
    }

    // unmatched markets -> listings with no canonical home yet
    for (const m of markets || []) {
      if (category && m.sport_tag !== category) continue;
      pushListing(m, "yes", null);
      pushListing(m, "no", null);
    }

    const lstUp = await upsert("listings", listingRows, "venue_id,venue_market_id,side", {
      returning: true,
    });
    if (lstUp.errors.length) {
      return res.status(500).json({ stage: "listings", errors: lstUp.errors.slice(0, 3) });
    }

    // ── seed quotes from v1 prices ────────────────────────────
    // v1 has a single price per side and no bid/ask, so record `mid`
    // only. recordQuotes' change detection means re-running backfill
    // won't append duplicate rows.
    const listingByKey = new Map(
      lstUp.rows.map(l => [`${l.venue_id}|${l.venue_market_id}|${l.side}`, l])
    );

    const quoteInput = [];
    for (const m of markets || []) {
      if (category && m.sport_tag !== category) continue;
      const venue = isKalshi(m.id) ? "kalshi" : "polymarket";
      for (const [side, price] of [["yes", m.yes_price], ["no", m.no_price]]) {
        const l = listingByKey.get(`${venue}|${m.id}|${side}`);
        if (!l || price == null) continue;
        quoteInput.push({
          listing_id: l.id,
          mid: Number(price),
          volume: m.volume == null ? null : Number(m.volume),
        });
      }
    }

    const { recordQuotes } = await import("../../../lib/v2/quotes.js");
    const qres = await recordQuotes(quoteInput);

    res.status(200).json({
      mode: "write",
      credential: credentialInUse(),
      category: category || "all",
      v1: { markets: (markets || []).length, pairs: (pairs || []).length, usablePairs: usablePairs.length },
      wrote: {
        events: evUp.count,
        outcomes: outUp.count,
        listings: lstUp.count,
        listingsMatched: listingRows.filter(l => l.outcome_id).length,
        listingsUnmatched: listingRows.filter(l => !l.outcome_id).length,
        quotesInserted: qres.inserted,
        quotesSkippedUnchanged: qres.skipped,
      },
      errors: [...evUp.errors, ...outUp.errors, ...lstUp.errors, ...qres.errors].slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
  }
}
