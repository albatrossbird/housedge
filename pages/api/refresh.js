import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const KALSHI_SERIES = [
  "KXWCGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME",
  "KXBTC", "KXETH", "KXFED", "KXCPI", "KXRECESSION", "KXGDP", "KXPRES",
];

const CHUNK = 100;

// Select-merge-upsert instead of hundreds of individual update() calls:
// firing dozens of concurrent per-row writes from one serverless
// invocation was hitting raw "fetch failed" network errors against
// Supabase. Pulling the existing full row first means the upsert payload
// always has every NOT NULL column (so it's still safe even though it's
// upsert, not a plain update), and it's a small number of bulk round
// trips instead of one per row.
async function applyUpdates(updates) {
  let updated = 0;
  const errors = [];

  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const ids = chunk.map(u => u.id);

    const { data: existing, error: selectError } = await supabase
      .from("markets")
      .select("*")
      .in("id", ids);

    if (selectError) {
      errors.push(`select: ${selectError.message}`);
      continue;
    }

    const existingById = new Map((existing || []).map(row => [row.id, row]));
    const merged = chunk
      .filter(u => existingById.has(u.id)) // never insert rows /api/embed hasn't created
      .map(u => ({ ...existingById.get(u.id), ...u }));

    if (merged.length === 0) continue;

    const { error } = await supabase.from("markets").upsert(merged, { onConflict: "id" });
    if (error) errors.push(`upsert: ${error.message}`);
    else updated += merged.length;
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
    const polyFetchErrors = [];
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
            } catch (err) {
              polyFetchErrors.push(`parse market ${m.id}: ${err.message}`);
            }
          }
        } else {
          polyFetchErrors.push(`gamma-api ${r.status}: ${(await r.text()).slice(0, 200)}`);
        }
      } catch (err) {
        polyFetchErrors.push(`fetch threw: ${err.message}`);
      }
    }

    const kalshiResult = await applyUpdates(kalshiUpdates);
    const polyResult   = await applyUpdates(polyUpdates);

    res.status(200).json({
      kalshiUpdated: kalshiResult.updated,
      polyUpdated: polyResult.updated,
      kalshiFetched: kalshiUpdates.length,
      polyFetched: polyUpdates.length,
      polyIdsInDb: polyIds.length,
      errors: [...kalshiResult.errors, ...polyResult.errors].slice(0, 5),
      polyFetchErrors: polyFetchErrors.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
