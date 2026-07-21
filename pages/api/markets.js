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

// Parse Kalshi ticker date format: "26JUL19" → Date object
const MONTH_MAP = {
  JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
  JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"
};

function extractTickerDate(id) {
  if (!id) return null;
  const match = String(id).toUpperCase().match(
    /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/
  );
  if (!match) return null;
  return new Date(`20${match[1]}-${MONTH_MAP[match[2]]}-${match[3]}`);
}

export default async function handler(req, res) {
  const category = req.query.category || "sports";
  const tags = SPORT_TAGS[category];
  if (!tags) return res.status(400).json({ error: `Unknown category: ${category}` });

  try {
    // Get today's date at midnight UTC for filtering past games
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

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
      .order("similarity", { ascending: false });

    if (error) throw error;

    // Get today at midnight for date filtering
    const todayMs = today.getTime();

    const shaped = (pairs || [])
      .filter(p => p.kalshi && p.poly)
      .filter(p => tags.includes(p.kalshi.sport_tag))
      .map(p => {
        const km = p.kalshi;
        const pm = p.poly;

        // Find correct Polymarket outcome index for our side
        let pYes = pm.yes_price;
        if (km.side_label && pm.outcomes && pm.outcome_prices) {
          try {
            const outcomes = JSON.parse(pm.outcomes);
            const prices   = JSON.parse(pm.outcome_prices);
            const sideKw   = km.side_label.toLowerCase()
              .split(/\W+/).filter(w => w.length > 2);
            const idx = outcomes.findIndex(o =>
              sideKw.some(w => o.toLowerCase().includes(w))
            );
            if (idx >= 0 && prices[idx] != null) {
              pYes = parseFloat(prices[idx]);
            }
          } catch { /* fall back to stored yes_price */ }
        }

        const kalshiUrl = `https://kalshi.com/markets/${
          (km.event_ticker || km.id).toLowerCase()
        }`;
        const polyUrl = pm.slug
          ? `https://polymarket.com/event/${pm.slug}`
          : "https://polymarket.com/";

        return {
          id:         km.id,
          title:      km.title,
          polyTitle:  pm.title,
          similarity: p.similarity,
          category:   km.sport_tag,
          _gameDate:  extractTickerDate(km.id), // for filtering, not displayed
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
      .filter(m => {
        // 1. Filter out markets with no valid prices
        if (!m.kalshi.yes || !m.poly.yes) return false;
        if (m.kalshi.yes <= 0.01 || m.kalshi.yes >= 0.99) return false;
        if (m.poly.yes   <= 0.01 || m.poly.yes   >= 0.99) return false;

        // 2. Filter out completed/past games using ticker date
        // Games from yesterday or earlier shouldn't show — Kalshi sometimes
        // lags in closing markets for completed games, and Polymarket
        // prices go to 100/0 after resolution. Both cases are caught here.
        if (m._gameDate && m._gameDate.getTime() < todayMs) return false;

        return true;
      })
      .map(({ _gameDate, ...m }) => m); // remove internal _gameDate field

    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({ pairs: shaped, needsEmbed: shaped.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
