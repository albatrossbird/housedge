import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const KALSHI_SERIES = [
  "KXWCGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME",
  "KXBTC", "KXETH", "KXFED", "KXCPI", "KXRECESSION", "KXGDP", "KXPRES",
];

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

    // Fetch fresh prices from Polymarket pairs already in DB
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
      const idsParam = batch.join(",");
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/markets?id=${idsParam}`);
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

    // Update Kalshi prices
    const kalshiUpdates = kalshiMarkets
      .filter(m => m.ticker && m.yes_ask_dollars)
      .map(m => ({
        id:         m.ticker,
        yes_price:  parseFloat(m.yes_ask_dollars),
        no_price:   1 - parseFloat(m.yes_ask_dollars),
        volume:     parseFloat(m.volume_24h_fp || 0),
        updated_at: Math.floor(Date.now() / 1000),
      }));

    // Upsert all price updates
    let kalshiCount = 0, polyCount = 0;
    for (let i = 0; i < kalshiUpdates.length; i += 100) {
      const { error } = await supabase.from("markets")
        .upsert(kalshiUpdates.slice(i, i + 100), { onConflict: "id" });
      if (!error) kalshiCount += Math.min(100, kalshiUpdates.length - i);
    }
    for (let i = 0; i < polyUpdates.length; i += 100) {
      const { error } = await supabase.from("markets")
        .upsert(polyUpdates.slice(i, i + 100), { onConflict: "id" });
      if (!error) polyCount += Math.min(100, polyUpdates.length - i);
    }

    res.status(200).json({
      kalshiUpdated: kalshiCount,
      polyUpdated: polyCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
