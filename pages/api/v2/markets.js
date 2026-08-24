// v2 read path — the eventual replacement for /api/markets.
//
//   /api/v2/markets?category=econ
//   /api/v2/markets?category=mlb&limit=20
//
// Reads v2_market_view (events -> outcomes -> listings -> latest quote)
// and nests it into one object per event. Unlike get_pairs(), this is
// not limited to two venues or two outcomes: an event carries whatever
// outcome set it has, and each outcome carries however many venues list
// it.
//
// Not yet wired to the frontend — /api/markets (v1) still serves the
// live site until this is validated against it.

import { rest, credentialInUse } from "../../../lib/v2/db.js";

// Cross-venue arb over a complete outcome set: if you can buy every
// outcome for less than $1 total, the set pays $1 regardless of result.
//
// Only valid when the outcome set is mutually exclusive AND exhaustive,
// hence the events.outcomes_exhaustive gate — summing a partial set is
// meaningless. Uses ask (what you pay), never mid.
//
// NOTE: this is gross of fees. Kalshi and Polymarket have different fee
// structures and neither is modelled yet, so treat a small positive edge
// here as "worth checking", not "free money". See docs/architecture-v2.md.
function computeArb(outcomes, exhaustive) {
  if (!exhaustive) return null;

  let total = 0;
  const legs = [];
  for (const o of outcomes) {
    let best = null;
    for (const l of o.listings) {
      const px = l.ask ?? l.mid;
      if (px == null) continue;
      if (!best || px < best.price) best = { venue: l.venue_id, price: px, url: l.url };
    }
    if (!best) return null; // incomplete pricing — can't claim anything
    total += best.price;
    legs.push({ outcome: o.label, ...best });
  }

  return {
    totalCost: Number(total.toFixed(4)),
    edge: Number((1 - total).toFixed(4)),
    isArb: total < 1,
    feesIncluded: false,
    legs,
  };
}

export default async function handler(req, res) {
  const category = req.query.category || null;
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

  try {
    const filter = category ? `category=eq.${encodeURIComponent(category)}&` : "";
    const { data, error } = await rest(
      `v2_market_view?${filter}order=event_id,sort_order`,
      { headers: { Range: "0-9999" } }
    );
    if (error) return res.status(500).json({ error });

    // nest: event -> outcomes -> listings
    const events = new Map();
    for (const r of data || []) {
      if (!events.has(r.event_id)) {
        events.set(r.event_id, {
          id: r.event_id,
          category: r.category,
          title: r.event_title,
          subject: r.subject,
          region: r.region,
          period: { year: r.period_year, quarter: r.period_quarter },
          resolutionDate: r.resolution_date,
          outcomesExhaustive: r.outcomes_exhaustive,
          outcomes: new Map(),
        });
      }
      const ev = events.get(r.event_id);

      if (!ev.outcomes.has(r.outcome_id)) {
        ev.outcomes.set(r.outcome_id, {
          id: r.outcome_id,
          label: r.outcome_label,
          claim: r.claim_unit
            ? { unit: r.claim_unit, op: r.claim_op, value: r.claim_value }
            : null,
          sortOrder: r.sort_order,
          listings: [],
        });
      }

      if (r.listing_id) {
        ev.outcomes.get(r.outcome_id).listings.push({
          id: r.listing_id,
          venue_id: r.venue_id,
          venueMarketId: r.venue_market_id,
          side: r.side,
          title: r.listing_title,
          url: r.url,
          status: r.status,
          matchMethod: r.match_method,
          matchConfidence: r.match_confidence,
          bid: r.bid, ask: r.ask, mid: r.mid, last: r.last,
          volume: r.volume,
          quotedAt: r.quoted_at,
        });
      }
    }

    const shaped = [...events.values()]
      .map(ev => {
        const outcomes = [...ev.outcomes.values()].sort((a, b) => a.sortOrder - b.sortOrder);
        const venues = new Set(
          outcomes.flatMap(o => o.listings.map(l => l.venue_id))
        );
        return {
          ...ev,
          outcomes,
          venueCount: venues.size,
          venues: [...venues],
          arb: computeArb(outcomes, ev.outcomesExhaustive),
        };
      })
      // an event listed by only one venue has nothing to compare
      .filter(ev => ev.venueCount >= 2)
      .slice(0, limit);

    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({
      credential: credentialInUse(),
      category: category || "all",
      eventCount: shaped.length,
      events: shaped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
