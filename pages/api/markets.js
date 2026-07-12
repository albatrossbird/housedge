// pages/api/markets.js (v2 — Supabase-based)
// Fast path: reads confirmed pairs from Supabase, returns shaped data.
// No embedding, no matching. Runs on every 60s frontend refresh.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SPORT_TAGS = {
  sports:    ["soccer", "nba", "nhl", "mlb"],
  economics: ["econ"],
  crypto:    ["crypto"],
  politics:  ["politics"],
};

export default async function handler(req, res) {
  const category = req.query.category || "sports";
  const tags = SPORT_TAGS[category];
  if (!tags) return res.status(400).json({ error: `Unknown category: ${category}` });

  try {
    // Pull confirmed pairs where Kalshi market is in this category
    const { data: pairs, error } = await supabase
      .from("pairs")
      .select(`
        similarity,
        kalshi:kalshi_id (
          id, title, yes_price, no_price, volume,
          sport_tag, event_ticker, side_label, close_time
        ),
        poly:polymarket_id (
          id, title, yes_price, no_price, volume,
          slug, side_label, outcomes, outcome_prices
        )
      `)
      .in("kalshi.sport_tag", tags)
      .not("kalshi.yes_price", "is", null)
      .not("poly.yes_price", "is", null)
      .order("similarity", { ascending: false });

    if (error) throw error;

    const shaped = (pairs || [])
      .filter(p => p.kalshi && p.poly)
      .map(p => {
        const km = p.kalshi;
        const pm = p.poly;

        // Find correct Polymarket outcome index for our side
        let pYes = pm.yes_price;
        if (km.side_label && pm.outcomes && pm.outcome_prices) {
          try {
            const outcomes = JSON.parse(pm.outcomes);
            const prices   = JSON.parse(pm.outcome_prices);
            const sideKw   = km.side_label.toLowerCase().split(/\W+/).filter(w => w.length > 2);
            const idx = outcomes.findIndex(o =>
              sideKw.some(w => o.toLowerCase().includes(w))
            );
            if (idx >= 0 && prices[idx] != null) pYes = parseFloat(prices[idx]);
          } catch { /* fall back to stored yes_price */ }
        }

        const kalshiUrl = `https://kalshi.com/markets/${(km.event_ticker || km.id).toLowerCase()}`;
        const polyUrl   = pm.slug
          ? `https://polymarket.com/event/${pm.slug}`
          : "https://polymarket.com/";

        return {
          id:         km.id,
          title:      km.title,
          polyTitle:  pm.title,
          similarity: p.similarity,
          category:   km.sport_tag,
          kalshi: {
            yes:    km.yes_price,
            no:     km.no_price,
            volume: km.volume,
            url:    kalshiUrl,
          },
          poly: {
            yes:    pYes,
            no:     1 - pYes,
            volume: pm.volume,
            url:    polyUrl,
          },
          trending: (km.volume + pm.volume) > 5000,
        };
      })
      .filter(m =>
        m.kalshi.yes > 0.01 && m.kalshi.yes < 0.99 &&
        m.poly.yes   > 0.01 && m.poly.yes   < 0.99
      );

    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({ pairs: shaped, needsEmbed: shaped.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}