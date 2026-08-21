import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const KALSHI_SERIES = [
  "KXWCGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME",
  "KXBTC", "KXETH", "KXFED", "KXCPI", "KXRECESSION", "KXGDP", "KXPRES",
];

const CONCURRENCY = 25;

// Plain per-row updates, not upsert: this route only ever touches markets
// that /api/embed already wrote, so it should never attempt an insert. A
// bulk upsert with a partial column set (no platform/title/etc.) can fail
// NOT NULL constraints on the insert branch even when every row already
// exists, since Postgres validates the attempted row before it checks for
// a conflict. Runs in small concurrent chunks so one bad row can't stall
// the batch, and so failures surface per-row instead of per-bulk-call.
async function applyUpdates(updates) {
  let updated = 0;
  const errors = [];
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const batch = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(({ id, ...fields }) =>
        supabase.from("markets").update(fields).eq("id", id)
      )
    );
    for (const { error } of results) {
      if (error) errors.push(error.message);
      else updated++;
    }
  }
  return { updated, errors };
}

export default async function handler(req, res) {
  try {
    // Fetch fresh prices from Kalshi
    const kalshiResults = await Promise.all(
      KALSHI_SERIES.map(s =>
        fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=200&series_ticker=${s}`)
          .then(r => r.ok ? r.json() : { markets: [] })
          .then(d => d.markets || [])
          .catch(() => [])
      )
    );
    const kalshiMarkets = kalshiResults.flat();

    const kalshiUpdates = kalshiMarkets
      .filter(m => m.ticker && !m.ticker.startsWith("KXMVE") && m.yes_ask_dollars)
      .map(m => ({
        id:         m.ticker,
        yes_price:  parseFloat(m.yes_ask_dollars),
        no_price:   1 - parseFloat(m.yes_ask_dollars),
        volume:     parseFloat(m.volume_24h_fp || 0),
        updated_at: Math.floor(Date.now() / 1000),
      }));

    // Fetch fresh prices from Polymarket for pairs already in DB
    const { data: polyMarkets } = await supabase
      .from("markets")
      .select("id")
      .not("id", "ilike", "KX%")
      .limit(1000);

    const polyIds = (polyMarkets || []).map(m => m.id);

    // Fetch Polymarket prices in batches
    const polyUpdates = [];
    for (let i = 0; i < polyIds.length; i += 50) {
      const batch = polyIds.slice(i, i + 50);
      // Gamma API needs `id` repeated per value — a comma-joined list is
      // silently rejected, same as the tag=/label=/search= params.
      const idsParam = batch.map(id => `id=${encodeURIComponent(id)}`).join("&");
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/markets?${idsParam}`);
        if (r.ok) {
          const data = await r.json();
          const markets = Array.isArray(data) ? data : data.markets || [];
          for (const m of markets) {
            try {
              const prices = JSON.parse(m.outcomePrices || "[]");
              polyUpdates.push({
                id: m.id,
                yes_price: prices[0] != null ? parseFloat(prices[0]) : null,
                no_price:  prices[1] != null ? parseFloat(prices[1]) : null,
                volume:    parseFloat(m.volumeNum || m.volume || 0),
                updated_at: Math.floor(Date.now() / 1000),
              });
            } catch {}
          }
        }
      } catch {}
    }

    const kalshiResult = await applyUpdates(kalshiUpdates);
    const polyResult   = await applyUpdates(polyUpdates);

    res.status(200).json({
      kalshiUpdated: kalshiResult.updated,
      polyUpdated: polyResult.updated,
      kalshiFetched: kalshiUpdates.length,
      polyFetched: polyUpdates.length,
      errors: [...kalshiResult.errors, ...polyResult.errors].slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
