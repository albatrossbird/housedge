import { createClient } from "@supabase/supabase-js";
import { cronAuthorized } from "../../lib/cronAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const KALSHI_SERIES = [
  "KXWCGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME",
  "KXBTC", "KXETH", "KXFED", "KXCPI", "KXRECESSION", "KXGDP", "KXPRES",
];

const CHUNK = 100;

// Retries didn't change the outcome, which rules out plain transient
// flakiness. Bypassing supabase-js with raw REST calls here so failures
// carry the real underlying cause (err.cause / err.name) instead of the
// generic "TypeError: fetch failed" string the JS client's error object
// reduces everything to - that's the only way left to tell a DNS/TLS/
// connection-reset failure apart from something else without dashboard
// access to Vercel/Supabase logs.
function describeError(err) {
  const cause = err.cause;
  return {
    name: err.name,
    message: err.message,
    cause: cause ? { code: cause.code, message: cause.message, name: cause.name } : undefined,
  };
}

async function restFetch(path, options = {}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${path}`;
  try {
    const r = await fetch(url, {
      ...options,
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const text = await r.text();
    if (!r.ok) return { error: { httpStatus: r.status, body: text.slice(0, 300) } };
    return { data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { error: describeError(err) };
  }
}

// Select-merge-upsert instead of hundreds of individual update() calls:
// pulling the existing full row first means the upsert payload always has
// every NOT NULL column (so it's safe even though it's upsert, not a
// plain update), in a small number of bulk round trips instead of one
// call per row.
async function applyUpdates(updates) {
  let updated = 0;
  const errors = [];

  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const ids = chunk.map(u => u.id);
    const idList = ids.map(id => encodeURIComponent(id)).join(",");

    const { data: existing, error: selectError } = await restFetch(
      `markets?select=*&id=in.(${idList})`
    );

    if (selectError) {
      errors.push(`select: ${JSON.stringify(selectError)}`);
      continue;
    }

    const existingById = new Map((existing || []).map(row => [row.id, row]));
    const merged = chunk
      .filter(u => existingById.has(u.id)) // never insert rows /api/embed hasn't created
      .map(u => ({ ...existingById.get(u.id), ...u }));

    if (merged.length === 0) continue;

    const { error } = await restFetch("markets?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(merged),
    });
    if (error) errors.push(`upsert: ${JSON.stringify(error)}`);
    else updated += merged.length;
  }

  return { updated, errors };
}

export default async function handler(req, res) {
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

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

    // Fetch fresh prices from Polymarket for pairs already in DB.
    //
    // Paged, not .limit(): Supabase enforces a 1000-row cap SERVER-side,
    // so a larger client limit is silently ignored. An earlier fix here
    // raised .limit() to 5000 and appeared to work, but the query kept
    // returning exactly 1000 rows — confirmed later when embed.js showed
    // the same stuck-at-1000 behaviour. Range paging is the only way past
    // it, and without this refresh silently stops updating every
    // Polymarket market beyond the first thousand.
    const polyIds = [];
    for (let from = 0; from < 60000; from += 1000) {
      const { data, error } = await supabase
        .from("markets")
        .select("id")
        .not("id", "ilike", "KX%")
        .range(from, from + 999);
      if (error || !data || data.length === 0) break;
      polyIds.push(...data.map(m => m.id));
      if (data.length < 1000) break;
    }

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
