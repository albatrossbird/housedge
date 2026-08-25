import { createClient } from "@supabase/supabase-js";
import { cronAuthorized } from "../../lib/cronAuth.js";

const num = v => (v == null || v === "" ? null : (isFinite(Number(v)) ? Number(v) : null));

// Columns added by supabase/migrations/0004, which is run by hand in
// the Supabase dashboard. A deploy can land before the migration does,
// and PostgREST rejects an entire batch that names a column it doesn't
// know — which would stop price refreshes outright instead of degrading
// to what it can still write.
const BOOK_COLUMNS = [
  "bid", "ask", "no_bid", "no_ask", "bid_size", "ask_size",
  "fee_multiplier", "fee_schedule",
];

function stripBookColumns(row) {
  const out = { ...row };
  for (const c of BOOK_COLUMNS) delete out[c];
  return out;
}

function isMissingColumnError(error) {
  const s = typeof error === "string" ? error : JSON.stringify(error || "");
  return /PGRST204|42703|column .* does not exist|Could not find the .* column/i.test(s);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Seed series, kept so a run still refreshes the core sports and econ
// books even if the pairs table is empty. The real list is discovered
// from the data - see kalshiSeriesToRefresh().
const SEED_KALSHI_SERIES = [
  "KXWCGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME",
  "KXBTC", "KXETH", "KXFED", "KXCPI", "KXRECESSION", "KXGDP", "KXPRES",
];

// The seed list was the whole list, and it silently excluded every
// series the crypto and politics categories added: KXXRPMAXY,
// KXTOKENLAUNCH, KXRECOGSOMALI, KXVENEZDEFACTO and the rest. Those
// markets are paired and on the live site, and their prices were frozen
// at whatever the last /api/embed run wrote - the exact stale-price
// symptom this job exists to fix, just in the categories nobody had
// checked yet.
//
// A Kalshi ticker is "<SERIES>-<event>-<outcome>", so the series is
// recoverable from the ids already in the pairs table. Scoped to paired
// markets because those are the only ones the site renders; unpaired
// rows get their prices from the daily discovery run.
function seriesOf(ticker) {
  const s = String(ticker || "").split("-")[0];
  return s.startsWith("KX") ? s : null;
}

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
  const warnings = [];

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

    const send = payload => restFetch("markets?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(payload),
    });

    let { error } = await send(merged);

    if (error && isMissingColumnError(error)) {
      warnings.push(
        "bid/ask columns missing - run supabase/migrations/0004_bid_ask_and_fees.sql; " +
        "refreshing mid prices only until then"
      );
      ({ error } = await send(merged.map(stripBookColumns)));
    }

    if (error) errors.push(`upsert: ${JSON.stringify(error)}`);
    else updated += merged.length;
  }

  return { updated, errors, warnings: [...new Set(warnings)] };
}

export default async function handler(req, res) {
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  try {
    // Every pair on the site, so both venues' refresh lists come from
    // what is actually rendered rather than a hand-maintained constant.
    const pairRows = [];
    for (let from = 0; from < 200000; from += 1000) {
      const { data, error } = await supabase
        .from("pairs")
        .select("kalshi_id, polymarket_id")
        .range(from, from + 999);
      if (error || !data || data.length === 0) break;
      pairRows.push(...data);
      if (data.length < 1000) break;
    }

    const series = new Set(SEED_KALSHI_SERIES);
    for (const row of pairRows) {
      const s = seriesOf(row.kalshi_id);
      if (s) series.add(s);
    }
    const kalshiSeries = [...series];

    // Fetch fresh prices from Kalshi
    const kalshiResults = await Promise.all(
      kalshiSeries.map(s =>
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
        // The books this job has been discarding all along: it already
        // fetched them on every poll and kept only the ask, stored as
        // though it were a mid.
        bid:        num(m.yes_bid_dollars),
        ask:        num(m.yes_ask_dollars),
        no_bid:     num(m.no_bid_dollars),
        no_ask:     num(m.no_ask_dollars),
        bid_size:   num(m.yes_bid_size_fp),
        ask_size:   num(m.yes_ask_size_fp),
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
    // Only the Polymarket side of a pair. Refreshing all ~10k stored
    // Polymarket rows meant ~200 sequential Gamma calls and an 83-second
    // run for prices nothing displays; the paired subset is two orders
    // of magnitude smaller. Unpaired rows still get prices from the
    // daily discovery run.
    //
    // Numeric-only: Gamma's ?id= rejects a non-integer with a 422 that
    // fails the whole batch, and stored ids are text.
    const polyIds = [...new Set(
      pairRows.map(r => String(r.polymarket_id)).filter(id => /^\d+$/.test(id))
    )];

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
                bid:       num(m.bestBid),
                ask:       num(m.bestAsk),
                // Refreshed rather than written once: Polymarket has
                // changed its per-category rates mid-year, and a stale
                // schedule prices every edge in that category wrong.
                fee_schedule: m.feesEnabled && m.feeSchedule ? m.feeSchedule : null,
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
      kalshiSeriesRefreshed: kalshiSeries.length,
      pairsSeen: pairRows.length,
      errors: [...kalshiResult.errors, ...polyResult.errors].slice(0, 5),
      warnings: [...new Set([...(kalshiResult.warnings || []), ...(polyResult.warnings || [])])],
      polyFetchErrors: polyFetchErrors.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
