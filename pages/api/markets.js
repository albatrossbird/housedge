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

    // Use RPC function which runs a direct SQL join — bypasses all
    // the JS client query issues we've been hitting
    const { data, error } = await supabase.rpc("get_pairs", {
      sport_tags: tags,
    });

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(200).json({ pairs: [], needsEmbed: true });
    }

    const shaped = data
      .map(row => {
        let pYes = row.p_yes_price;
        if (row.p_outcomes && row.p_outcome_prices) {
          try {
            const outcomes = JSON.parse(row.p_outcomes);
            const prices   = JSON.parse(row.p_outcome_prices);
            const titleSide = (row.k_title || "").split("—").pop().trim();
            const sideKw = (row.k_side_label || titleSide).toLowerCase()
              .split(/\W+/).filter(w => w.length > 2);
            let idx = outcomes.findIndex(o => sideKw.some(w => o.toLowerCase().includes(w)));
            if (idx >= 0 && prices[idx] != null) pYes = parseFloat(prices[idx]);
          } catch {}
        }

        // Kalshi's site only reliably resolves the series-level page
        // (e.g. kalshi.com/markets/kxgdp) - a combined series+event+
        // strike ticker as one path segment (what this used to build)
        // 404s. The event-level URL needs a human-readable slug we
        // don't have (e.g. "annual-gdp", not the raw ticker), so this
        // links to the series page rather than guessing at that.
        const seriesTicker = (row.kalshi_id || "").split("-")[0];
        const kalshiUrl = seriesTicker
          ? `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`
          : "https://kalshi.com/";
        const polyUrl = row.p_slug ? `https://polymarket.com/event/${row.p_slug}` : "https://polymarket.com/";

        return {
          id: row.kalshi_id,
          title: row.k_title,
          polyTitle: row.p_title,
          similarity: row.similarity,
          category: row.k_sport_tag,
          _gameDate: extractTickerDate(row.kalshi_id),
          kalshi: { yes: row.k_yes_price, no: row.k_no_price, volume: row.k_volume || 0, url: kalshiUrl },
          poly: { yes: pYes, no: 1 - pYes, volume: row.p_volume || 0, url: polyUrl },
          trending: ((row.k_volume || 0) + (row.p_volume || 0)) > 5000,
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
