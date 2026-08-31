import { createClient } from "@supabase/supabase-js";

import { cleanTitle, polymarketUsUrl } from "../../lib/titles.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const POLY_PLATFORMS = ["polymarket", "polymarket_us"];
const PLATFORMS = ["kalshi", ...POLY_PLATFORMS];

// Never `select=*` here. A markets row carries a ~20KB JSON-encoded
// embedding, so a 200-row page would drag 4MB through a query that
// wants a title and a price. That exact mistake timed the refresh job
// out at the Postgres statement limit.
const COLS = [
  "id", "platform", "title", "yes_price", "no_price", "volume",
  "sport_tag", "side_label", "slug", "series_slug", "event_ticker", "updated_at",
].join(",");

const PER_PLATFORM = 60;

// PostgREST reads these as pattern/list syntax inside the query string.
function escapePattern(q) {
  return q.replace(/[%_*,()\\]/g, ch => `\\${ch}`);
}

function venueOf(platform) {
  if (platform === "kalshi") return "Kalshi";
  if (platform === "polymarket_us") return "Polymarket US";
  return "Polymarket (global)";
}

// Volume means three different things and is never compared across
// venues: Kalshi reports CONTRACTS, polymarket.com reports US DOLLARS,
// and polymarket.us publishes nothing at all. So it orders results
// WITHIN a platform and never between them.
function volumeOf(row) {
  if (row.platform === "polymarket_us") return { value: null, unit: null };
  if (row.platform === "kalshi") return { value: row.volume ?? null, unit: "contracts" };
  return { value: row.volume ?? null, unit: "usd" };
}

function marketUrl(row) {
  if (row.platform === "kalshi") {
    const series = String(row.id || "").split("-")[0].toLowerCase();
    const event = String(row.event_ticker || "").toLowerCase();
    if (series && row.series_slug) {
      return event
        ? `https://kalshi.com/markets/${series}/${row.series_slug}/${event}`
        : `https://kalshi.com/markets/${series}/${row.series_slug}`;
    }
    const q = String(row.title || "").split("—")[0].replace(/\*+/g, "").trim().slice(0, 80);
    return q ? `https://kalshi.com/search?q=${encodeURIComponent(q)}` : "https://kalshi.com/";
  }
  if (row.platform === "polymarket_us") return polymarketUsUrl(row.slug, row.event_ticker);
  return row.slug ? `https://polymarket.com/event/${row.slug}` : "https://polymarket.com/";
}

// How well a title answers what was typed. Volume cannot rank across
// venues, so relevance has to, and a plain ILIKE gives no ordering of
// its own — "Bitcoin" would otherwise rank a market that merely mentions
// it above the market about it.
function relevance(title, q) {
  const t = String(title || "").toLowerCase();
  const needle = q.toLowerCase().trim();
  if (!needle) return 0;
  if (t === needle) return 100;
  if (new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t)) return 50;
  if (t.startsWith(needle)) return 45;
  return 20;
}

// A market with no price, or one sitting at 0 or 1, is settled or was
// never quoted. It is still a real answer to "does this market exist",
// so it is ranked last rather than hidden — searching for a market and
// being told nothing at all is worse than being told it is done.
function isLive(row) {
  const y = row.yes_price;
  return typeof y === "number" && y > 0 && y < 1;
}

// Comparison is what the site is for, so a claim quoted on two venues
// outranks one quoted on a single venue even when the single one
// matches the words slightly better. Without this, searching "bitcoin"
// put four settled "Bitcoin all time high by <past date>?" markets
// above every matched pair, purely because their titles start with the
// word.
function score({ relevance: rel, kind, live }) {
  return rel + (kind === "matched" ? 40 : 0) + (live ? 20 : -40);
}

async function chunkedIn(column, values, select) {
  const out = [];
  // `.in()` puts its values in the QUERY STRING, so a few hundred ids
  // build a URL long enough to kill the request — and supabase-js
  // returns that as an error object that is easy to ignore.
  for (let i = 0; i < values.length; i += 200) {
    const { data, error } = await supabase
      .from(column.table).select(select).in(column.name, values.slice(i, i + 200)).limit(1000);
    if (error) throw new Error(`${column.table}.${column.name}: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

export default async function handler(req, res) {
  const q = String(req.query.q || "").trim();
  const limit = Math.min(Number(req.query.limit) || 40, 100);

  if (q.length < 2) {
    return res.status(200).json({ query: q, results: [], counts: { total: 0 }, hint: "Type at least two characters." });
  }

  try {
    const pattern = `%${escapePattern(q)}%`;

    // One query per platform so the volume ordering inside each is
    // meaningful. A single query ordered by volume would rank Kalshi
    // contracts against Polymarket dollars, which is not a comparison.
    const perPlatform = await Promise.all(PLATFORMS.map(async platform => {
      const { data, error } = await supabase
        .from("markets").select(COLS)
        .eq("platform", platform)
        .ilike("title", pattern)
        .order("volume", { ascending: false, nullsFirst: false })
        .limit(PER_PLATFORM);
      if (error) throw new Error(`markets[${platform}]: ${error.message}`);
      return data || [];
    }));

    const found = perPlatform.flat();
    if (!found.length) {
      return res.status(200).json({ query: q, results: [], counts: { total: 0, matched: 0, unmatched: 0 } });
    }

    const kalshiIds = found.filter(r => r.platform === "kalshi").map(r => r.id);
    const polyIds   = found.filter(r => r.platform !== "kalshi").map(r => r.id);

    // A hit on either side of a pair should surface the whole pair, so
    // pairs are looked up from both directions.
    const pairRows = [
      ...(kalshiIds.length ? await chunkedIn({ table: "pairs", name: "kalshi_id" }, kalshiIds, "kalshi_id,polymarket_id,similarity") : []),
      ...(polyIds.length   ? await chunkedIn({ table: "pairs", name: "polymarket_id" }, polyIds, "kalshi_id,polymarket_id,similarity") : []),
    ];
    const seenPair = new Set();
    const pairs = pairRows.filter(p => {
      const k = `${p.kalshi_id}|${p.polymarket_id}`;
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    });

    // Counterparts the search itself did not return — the whole point is
    // that searching one venue shows you the other.
    const have = new Set(found.map(r => r.id));
    const missing = [...new Set(pairs.flatMap(p => [p.kalshi_id, p.polymarket_id]).filter(id => !have.has(id)))];
    const extra = missing.length ? await chunkedIn({ table: "markets", name: "id" }, missing, COLS) : [];

    const byId = new Map([...found, ...extra].map(r => [r.id, r]));

    // Group into one result per CLAIM: a matched set is one result with
    // its venues, an unmatched market is one result on its own. Anything
    // else shows the same claim twice and calls it two findings.
    const legsFor = new Map();   // kalshi id -> pair rows
    const claimed = new Set();
    for (const p of pairs) {
      if (!byId.has(p.kalshi_id) || !byId.has(p.polymarket_id)) continue;
      if (!legsFor.has(p.kalshi_id)) legsFor.set(p.kalshi_id, []);
      legsFor.get(p.kalshi_id).push(p);
      claimed.add(p.kalshi_id);
      claimed.add(p.polymarket_id);
    }

    const shape = row => ({
      id: row.id,
      platform: row.platform,
      venue: venueOf(row.platform),
      title: cleanTitle(row.title),
      yes: row.yes_price ?? null,
      no: row.no_price ?? null,
      volume: volumeOf(row),
      category: row.sport_tag || null,
      url: marketUrl(row),
    });

    const results = [];

    for (const [kalshiId, ps] of legsFor) {
      const k = byId.get(kalshiId);
      results.push({
        kind: "matched",
        category: k.sport_tag || null,
        market: shape(k),
        counterparts: ps
          .map(p => ({ ...shape(byId.get(p.polymarket_id)), similarity: p.similarity }))
          .sort((a, b) => (a.platform === "polymarket_us" ? -1 : 1) - (b.platform === "polymarket_us" ? -1 : 1)),
        relevance: Math.max(relevance(k.title, q), ...ps.map(p => relevance(byId.get(p.polymarket_id).title, q))),
        live: isLive(k) || ps.some(p => isLive(byId.get(p.polymarket_id))),
      });
    }

    for (const row of found) {
      if (claimed.has(row.id)) continue;
      results.push({
        kind: "unmatched",
        category: row.sport_tag || null,
        market: shape(row),
        counterparts: [],
        relevance: relevance(row.title, q),
        live: isLive(row),
      });
    }

    for (const r of results) r.score = score(r);
    results.sort((a, b) => b.score - a.score || String(a.market.title).localeCompare(String(b.market.title)));

    const trimmed = results.slice(0, limit);
    return res.status(200).json({
      query: q,
      results: trimmed,
      counts: {
        total: results.length,
        matched: results.filter(r => r.kind === "matched").length,
        unmatched: results.filter(r => r.kind === "unmatched").length,
        settled: results.filter(r => !r.live).length,
        returned: trimmed.length,
      },
      // Search is DISCOVERY, not execution pricing. The arb figures live
      // in /api/markets with the fee maths and the depth re-check; a
      // second copy here would be a second place for them to drift, and
      // a midpoint gap shown next to a price reads as an edge when it is
      // not one. Matched results link to the tab that prices them.
      pricing: { executable: false, note: "Prices are last-seen mid quotes. Executable cost and any arb are on the category tabs." },
    });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
