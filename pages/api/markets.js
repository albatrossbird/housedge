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
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    // Fetch ALL markets and pairs, filter in JS to avoid Supabase query issues
    const [pairsRes, marketsRes] = await Promise.all([
      supabase.from("pairs").select("id, kalshi_id, polymarket_id, similarity").order("similarity", { ascending: false }),
      supabase.from("markets").select("id, title, yes_price, no_price, volume, sport_tag, event_ticker, side_label, close_time, slug, outcomes, outcome_prices"),
    ]);

    if (pairsRes.error) throw pairsRes.error;
    if (marketsRes.error) throw marketsRes.error;

    const pairs = pairsRes.data || [];
    const allMarkets = marketsRes.data || [];

    // Split into Kalshi and Polymarket by ID pattern in JS
    const kalshiById = {};
    const polyById = {};
    for (const m of allMarkets) {
      if (String(m.id).startsWith("KX")) {
        if (tags.includes(m.sport_tag)) kalshiById[m.id] = m;
      } else {
        polyById[m.id] = m;
      }
    }

    if (pairs.length === 0) {
      return res.status(200).json({ pairs: [], needsEmbed: true });
    }

    const shaped = pairs
      .filter(p => kalshiById[p.kalshi_id] && polyById[p.polymarket_id])
      .map(p => {
        const km = kalshiById[p.kalshi_id];
        const pm = polyById[p.polymarket_id];

        let pYes = pm.yes_price;
        if (pm.outcomes && pm.outcome_prices) {
          try {
            const outcomes = JSON.parse(pm.outcomes);
            const prices   = JSON.parse(pm.outcome_prices);
            const titleSide = (km.title || "").split("—").pop().trim();
            const sideKw = (km.side_label || titleSide).toLowerCase()
              .split(/\W+/).filter(w => w.length > 2);
            let idx = outcomes.findIndex(o => sideKw.some(w => o.toLowerCase().includes(w)));
            if (idx >= 0 && prices[idx] != null) pYes = parseFloat(prices[idx]);
          } catch {}
        }

        const kalshiUrl = `https://kalshi.com/markets/${(km.event_ticker || km.id).toLowerCase()}`;
        const polyUrl = pm.slug ? `https://polymarket.com/event/${pm.slug}` : "https://polymarket.com/";

        return {
          id: km.id, title: km.title, polyTitle: pm.title,
          similarity: p.similarity, category: km.sport_tag,
          _gameDate: extractTickerDate(km.id),
          kalshi: { yes: km.yes_price, no: km.no_price, volume: km.volume || 0, url: kalshiUrl },
          poly: { yes: pYes, no: 1 - pYes, volume: pm.volume || 0, url: polyUrl },
          trending: ((km.volume || 0) + (pm.volume || 0)) > 5000,
        };
      })
      .filter(m => {
        if (!m.kalshi.yes || !m.poly.yes) return false;
        if (m.kalshi.yes <= 0.05 || m.kalshi.yes >= 0.95) return false;
        if (m.poly.yes   <= 0.05 || m.poly.yes   >= 0.95) return false;
        if (m._gameDate && m._gameDate.getTime() < todayMs) return false;
        return true;
      })
      .map(({ _gameDate, ...m }) => m);

    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({ pairs: shaped, needsEmbed: shaped.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
