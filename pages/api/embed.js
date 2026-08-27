// pages/api/embed.js
// Hybrid matching engine:
// - SPORTS: structured team-name extraction (both teams must match)
// - ECONOMICS/CRYPTO/POLITICS: Voyage AI embeddings (semantic matching)
//
// Usage:
//   /api/embed?sport=mlb       — match MLB games
//   /api/embed?sport=soccer    — match soccer games
//   /api/embed?sport=econ      — embed + match economics markets
//   /api/embed?matchonly=1&sport=mlb — re-run matching without re-fetching
//   /api/embed?force=1         — re-embed even already-stored markets

import { createClient } from "@supabase/supabase-js";
import { scalarSignaturesCompatible } from "../../lib/v2/claims.js";
import { kalshiGameKey, polyGameKey } from "../../lib/sportsKeys.js";
import { fetchUsGameMarket, fetchPolymarketUs, toMarketRow, POLY_US_PLATFORM } from "../../lib/polymarketUs.js";
import { cronAuthorized } from "../../lib/cronAuth.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Raw Supabase REST writes ─────────────────────────────────────
// supabase-js's returned error object reduces every network-layer
// failure down to a generic "TypeError: fetch failed" string, and none
// of the upserts below were even checking that much - they were fired
// and forgotten. Writes go through raw REST calls instead so failures
// are actually diagnosable (see the /api/refresh fix history for why -
// this is the same class of bug, just never instrumented here).
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
    const cause = err.cause;
    return {
      error: {
        name: err.name,
        message: err.message,
        cause: cause ? { code: cause.code, message: cause.message } : undefined,
      },
    };
  }
}

// Columns added by supabase/migrations/0004. The migration is run by
// hand in the Supabase dashboard, so a deploy can land before it does —
// and PostgREST rejects the whole batch when a payload names a column
// that doesn't exist, which would take /api/refresh down entirely
// rather than degrading. When that happens these keys are dropped and
// the write retried, with a warning in the response so the cause is
// visible rather than looking like the fields were simply never
// populated.
const V1_BOOK_COLUMNS = [
  "bid", "ask", "no_bid", "no_ask", "bid_size", "ask_size",
  "fee_multiplier", "fee_schedule", "series_slug", "embedding_v",
];

export function stripBookColumns(row) {
  const out = { ...row };
  for (const c of V1_BOOK_COLUMNS) delete out[c];
  return out;
}

export function isMissingColumnError(error) {
  const s = typeof error === "string" ? error : JSON.stringify(error || "");
  // PostgREST surfaces this as PGRST204 or Postgres 42703 depending on
  // whether it is the schema cache or the planner that notices first.
  return /PGRST204|42703|column .* does not exist|Could not find the .* column/i.test(s);
}

// PostgREST requires every object in a bulk insert to carry the same
// keys, and rejects the whole batch with PGRST102 "All object keys must
// match" otherwise. Kalshi and Polymarket rows are upserted together and
// legitimately diverge — only Kalshi has a separate NO book, a series
// slug and a fee multiplier; only Polymarket has a fee schedule.
//
// This was masked until migration 0004 ran: with the columns absent,
// every book field was stripped from both platforms, which happened to
// make the key sets match again. Applying the migration is what exposed
// it, so the fix belongs here rather than in the column list.
//
// Filling the gaps with null is accurate, not merely convenient — a
// Polymarket row genuinely has no fee_multiplier.
function alignKeys(batch) {
  const keys = new Set();
  for (const row of batch) for (const k of Object.keys(row)) keys.add(k);
  return batch.map(row => {
    const out = { ...row };
    for (const k of keys) if (!(k in out)) out[k] = null;
    return out;
  });
}

async function upsertRows(table, rows, onConflict, batchSize = 50) {
  const errors = [];
  const warnings = [];
  let count = 0;
  let stripBooks = false;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = alignKeys(rows.slice(i, i + batchSize));

    const send = payload => restFetch(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(payload),
    });

    let { error } = await send(stripBooks ? alignKeys(batch.map(stripBookColumns)) : batch);

    if (error && !stripBooks && isMissingColumnError(error)) {
      stripBooks = true;
      warnings.push(
        "bid/ask columns missing - run supabase/migrations/0004_bid_ask_and_fees.sql; " +
        "writing prices without books until then"
      );
      ({ error } = await send(alignKeys(batch.map(stripBookColumns))));
    }

    // Counted only on success. This used to increment per batch
    // attempted, so a run could report marketsUpserted=913 in the same
    // response that carried a write error — the failure looked like a
    // full write.
    if (error) errors.push(JSON.stringify(error));
    else count += batch.length;
  }
  return { count, errors, warnings };
}

// ── Paged reads ────────────────────────────────────────────────
// Supabase caps a single select at 1000 rows SERVER-side, so a client
// .limit(20000) is silently ignored — confirmed by observing kalshiCount
// stuck at exactly 1000 across repeated runs after raising the limit.
// Range-based paging is the only way to read past it.
//
// This matters more than it looks: the cap silently truncates BOTH
// matching (only the first 1000 rows are considered) and pair clearing
// (stale rejected pairs survive because their ids were never in the
// capped list), and neither reports anything wrong.
async function fetchAllRows(buildQuery, { pageSize = 1000, maxRows = 60000, errors = null } = {}) {
  const out = [];
  let size = pageSize;
  let from = 0;

  while (from < maxRows) {
    const { data, error } = await buildQuery().range(from, from + size - 1);

    if (error) {
      // A page carrying `embedding` is enormous — roughly 20KB per row,
      // so a 1000-row page is ~20MB — and past some size the request
      // simply fails. When crypto and politics grew past ~4,000
      // Polymarket rows this started failing on the FIRST page, and
      // because the old code did `if (error) break` and returned [],
      // the category reported zero stored markets while the live site
      // was still serving pairs built from those very rows.
      //
      // Halve and retry before giving up: a smaller page nearly always
      // succeeds, so the read degrades in speed rather than in truth.
      if (size > 100) { size = Math.floor(size / 2); continue; }
      if (errors) errors.push(`page at ${from} (size ${size}): ${error.message || JSON.stringify(error)}`);
      break;
    }

    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return out;
}

// ── Voyage AI embedding (used for non-sports markets) ──────────
async function embedTitles(titles) {
  if (!titles.length) return [];
  const BATCH_SIZE = 128;
  const allEmbeddings = [];

  for (let i = 0; i < titles.length; i += BATCH_SIZE) {
    const batch = titles.slice(i, i + BATCH_SIZE);
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "voyage-4-large",
        input: batch,
        input_type: "document",
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Voyage AI error ${res.status}: ${err}`);
    }
    const data = await res.json();
    allEmbeddings.push(...data.data.map(d => d.embedding));
  }
  return allEmbeddings;
}

// ── Cosine similarity ──────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Numeric/period/region signature extraction now lives in
// lib/v2/claims.js so the v2 schema layer uses the exact same parsers —
// see that file for why these gates exist and how they're scoped.

// ── Candidate generation in the database (pgvector) ─────────────
//
// The JS matcher below reads every embedding out of Postgres and
// compares them in this process. That is ~20KB a row, which is what
// made a 1000-row page ~20MB and started failing outright once crypto
// and politics grew past a few thousand rows — a read failure that
// presented as an empty category.
//
// match_candidates() (migration 0007) does the comparison in the
// database and returns only (kalshi_id, polymarket_id, score), so no
// embedding crosses the wire. Titles still come back — they are small,
// and the scalar-signature gate needs them.
//
// Returns null when the RPC is unavailable (0007 not run yet), so the
// caller falls back to the JS path rather than failing.
async function candidatesFromDb(sportTag, topK = 10) {
  const { data, error } = await supabase.rpc("match_candidates", {
    p_sport_tag: sportTag,
    p_top_k: topK,
  });

  if (error) {
    // "function does not exist" is the expected pre-migration state, not
    // a fault. Anything else is worth surfacing rather than silently
    // degrading to the slow path forever.
    const msg = error.message || JSON.stringify(error);
    return /does not exist|PGRST202|schema cache/i.test(msg)
      ? null
      : { error: msg };
  }
  return { rows: data || [] };
}

// ── Shared embedding-based matcher for non-sports markets ────────
// Used by both matchonly and normal mode so they can't drift apart -
// they duplicated this logic separately for a while this session and
// it caused real bugs (a diagnostic added to one branch and forgotten
// in the other).
// Exclusivity and ordering, shared by both matchers.
//
// Greedy by globally descending score, not by Kalshi row order: when
// several Kalshi rows compete for the same Polymarket market, the
// best-scoring candidate should win it rather than whichever row
// happened to be processed first.
function assignGreedy(candidates, topScores, threshold, counts = {}) {
  candidates.sort((a, b) => b.score - a.score);

  // A Kalshi market may pair once PER POLYMARKET VENUE, not once
  // overall. polymarket.com and polymarket.us are different exchanges
  // and a US account can only trade the .us one, so letting a single
  // .com match consume the Kalshi row hides the only pair the reader
  // could actually take. That is why 307 ingested and embedded US
  // non-sports markets produced zero pairs: they were not rejected by
  // threshold or by the gate, they simply lost the exclusivity race to
  // a .com candidate that scored higher.
  //
  // The sports join was already one pair per (game, venue); this makes
  // the embedding path agree.
  const usedKalshi = new Set();
  const usedPoly = new Set();
  const venueOf = pm => (pm.platform === POLY_US_PLATFORM ? POLY_US_PLATFORM : "polymarket");
  const newPairs = [];
  const acceptedPairs = [];

  for (const c of candidates) {
    const kalshiSlot = `${c.km.id}|${venueOf(c.pm)}`;
    if (usedKalshi.has(kalshiSlot) || usedPoly.has(c.pm.id)) continue;
    newPairs.push({
      kalshi_id:     c.km.id,
      polymarket_id: c.pm.id,
      similarity:    c.score,
      created_at:    Math.floor(Date.now() / 1000),
    });
    acceptedPairs.push({ score: c.score, kalshi: c.km.title, poly: c.pm.title });
    usedKalshi.add(kalshiSlot);
    usedPoly.add(c.pm.id);
  }

  topScores.sort((a, b) => b.score - a.score);
  acceptedPairs.sort((a, b) => b.score - a.score);

  return {
    newPairs,
    matchDiagnostics: {
      threshold,
      ...counts,
      acceptedPairs: acceptedPairs.slice(0, 100),
      // Uncapped rather than top-10: the head of the list is dominated
      // by one cluster (e.g. GDP buckets), which hides whether other
      // families have real candidates further down.
      topScores,
    },
  };
}

// Same policy as the JS matcher — gate, then globally-greedy assignment
// — over candidates the database produced. Deliberately shares the
// assignment and diagnostics code path so the two cannot drift, which
// is the mistake matchonly and normal mode already made once.
function matchFromDbCandidates(rows, byId, threshold) {
  const topScores = [];
  const candidates = [];
  const bestPerKalshi = new Map();

  for (const r of rows) {
    const km = byId.get(String(r.kalshi_id));
    const pm = byId.get(String(r.polymarket_id));
    if (!km || !pm) continue; // row pruned between the RPC and the read
    const score = Number(r.score);

    const prev = bestPerKalshi.get(km.id);
    if (!prev || score > prev.score) bestPerKalshi.set(km.id, { score, km, pm });

    if (score >= threshold && scalarSignaturesCompatible(km.title, pm.title, km.sport_tag)) {
      candidates.push({ km, pm, score });
    }
  }

  for (const b of bestPerKalshi.values()) {
    topScores.push({ score: b.score, kalshi: b.km.title, poly: b.pm.title });
  }

  return assignGreedy(candidates, topScores, threshold, { matcher: "pgvector" });
}

function matchNonSportsMarkets(kalshiDb, polyDb, threshold) {
  const polyEmbedded = (polyDb || [])
    .filter(m => m.embedding)
    .map(m => ({ ...m, _vec: JSON.parse(m.embedding) }));

  const topScores = [];
  const candidates = [];

  for (const km of (kalshiDb || [])) {
    if (!km.embedding) continue;
    const kVec = JSON.parse(km.embedding);
    let rowBestScore = 0;
    let rowBestPm = null;

    for (const pm of polyEmbedded) {
      if (km.sport_tag !== pm.sport_tag) continue;
      const score = cosineSimilarity(kVec, pm._vec);
      if (score > rowBestScore) {
        rowBestScore = score;
        rowBestPm = pm;
      }
      if (score >= threshold && scalarSignaturesCompatible(km.title, pm.title, km.sport_tag)) {
        candidates.push({ km, pm, score });
      }
    }

    if (rowBestPm) {
      topScores.push({ score: rowBestScore, kalshi: km.title, poly: rowBestPm.title });
    }
  }

  // Greedy by globally descending score, not by Kalshi row order - so
  // when several Kalshi rows compete for the same Polymarket market,
  // the actual best-scoring candidate wins it instead of whichever
  // Kalshi row happened to be processed first.
  return assignGreedy(candidates, topScores, threshold, {
    kalshiEmbeddedCount: (kalshiDb || []).filter(m => m.embedding).length,
    polyEmbeddedCount: polyEmbedded.length,
    matcher: "js",
  });
}
// A Polymarket event carries several markets per game (moneyline, NRFI,
// ── Sports matching: join on the game, don't parse the title ───
//
// The title-regex approach broke silently and took the whole Sports tab
// with it. Kalshi changed its game-market wording:
//
//   stored Aug 11:  "Cincinnati vs Chicago WS Winner? — Chicago WS"
//   live   Aug 25:  "San Francisco wins — San Francisco"
//
// extractKalshiTeams() required "<A> vs <B> Winner?", so all 74 open
// MLB markets returned null and were skipped. Only the stale rows still
// sitting in `markets` parsed, which is why a fresh discovery run
// produced 66 pairs and 61 of them were for games played two weeks
// earlier.
//
// Both venues already publish the game as structured identifiers, so
// there is no need to read prose at all (see lib/sportsKeys.js):
//
//   Kalshi ticker  KXMLBGAME-26AUG271910MILNYM-NYM
//                             ^date    ^teams ^side
//   Poly    slug   mlb-mil-nym-2026-08-27
//
// Reduced to {date, unordered pair of team codes} these are the same
// key, so matching is an exact join: no similarity score, no 6-hour
// date window, and no 30-team alias map per league. On the live
// Aug 25-27 fixtures this joins 37 of 37 games.
//
// A market with no parseable key simply has no key and cannot join,
// which also closes the hole where a Polymarket futures market
// ("mlb-world-series-champion-2026", no date in the slug) could match a
// single game — datesCompatible() used to read a missing date as
// permission to pair.

// A Polymarket event carries several markets per game (moneyline, NRFI,
// spreads, totals). Only the moneyline is the same bet as Kalshi's
// "<team> wins".
function isMoneylineTitle(title) {
  const t = String(title || "").toLowerCase();
  return !/(inning|o\/u|over\/under|tied|score|spread|\(-|\(\+)/.test(t);
}

function matchSportsMarkets(kalshiMarkets, polyMarkets, sportTag) {
  const todayIso = new Date().toISOString().slice(0, 10);

  const diagnostics = {
    kalshiRows: kalshiMarkets.length,
    polyRows: 0,
    kalshiKeyed: 0,
    polyKeyed: 0,
    pastGamesSkipped: 0,
    joined: 0,
    // The failure that hid this bug for two weeks. If a venue changes
    // its identifier format again, this goes to (near) zero while
    // everything else still looks healthy.
    kalshiKeyFailures: 0,
    sampleKeyFailures: [],
    unjoinedKalshiKeys: [],
  };

  // Index Polymarket by (game key, venue), preferring the moneyline
  // market. Keyed by venue as well as game because polymarket.com and
  // polymarket.us are different exchanges with different books, and a US
  // account can only trade the .us one — so a game should pair against
  // each venue that lists it rather than one of them winning.
  const polyByKey = new Map();
  for (const pm of polyMarkets) {
    if (pm.sport_tag !== sportTag) continue;
    diagnostics.polyRows++;
    const pk = polyGameKey(pm.slug);
    if (!pk) continue;
    diagnostics.polyKeyed++;
    if (pk.date < todayIso) continue;

    const venue = pm.platform === POLY_US_PLATFORM ? POLY_US_PLATFORM : "polymarket";
    const mapKey = `${pk.key}|${venue}`;
    const existing = polyByKey.get(mapKey);
    if (!existing || (!isMoneylineTitle(existing.title) && isMoneylineTitle(pm.title))) {
      polyByKey.set(mapKey, pm);
    }
  }

  // One pair per game. Kalshi lists a market per side and Polymarket
  // one two-outcome market, so both Kalshi sides key to the same game;
  // markets.js already resolves which Polymarket outcome a given side
  // refers to. Taking the lowest ticker keeps that choice deterministic
  // instead of dependent on row order.
  const bySide = new Map();
  for (const km of kalshiMarkets) {
    const kk = kalshiGameKey(km.id);
    if (!kk) {
      diagnostics.kalshiKeyFailures++;
      if (diagnostics.sampleKeyFailures.length < 5) {
        diagnostics.sampleKeyFailures.push({ id: km.id, title: (km.title || "").slice(0, 60) });
      }
      continue;
    }
    diagnostics.kalshiKeyed++;
    if (kk.date < todayIso) { diagnostics.pastGamesSkipped++; continue; }

    const prev = bySide.get(kk.key);
    if (!prev || String(km.id) < String(prev.id)) bySide.set(kk.key, km);
  }

  const matched = [];
  diagnostics.joinedByVenue = {};
  for (const [key, km] of bySide) {
    let any = false;
    for (const venue of ["polymarket", POLY_US_PLATFORM]) {
      const pm = polyByKey.get(`${key}|${venue}`);
      if (!pm) continue;
      any = true;
      diagnostics.joined++;
      diagnostics.joinedByVenue[venue] = (diagnostics.joinedByVenue[venue] || 0) + 1;
      matched.push({
        kalshi_id:     km.id,
        polymarket_id: pm.id,
        // An exact identifier join, not a similarity estimate.
        similarity:    1.0,
        created_at:    Math.floor(Date.now() / 1000),
      });
    }
    if (!any && diagnostics.unjoinedKalshiKeys.length < 10) {
      diagnostics.unjoinedKalshiKeys.push(key);
    }
  }

  return { newPairs: matched, matchDiagnostics: diagnostics };
}


// Kalshi's game markets are titled from one side only — "San Francisco
// wins" — which reads as a fragment in the UI and drops the matchup
// entirely. rules_primary states it in full:
//
//   "If San Francisco wins the Arizona vs San Francisco professional
//    baseball game originally scheduled for Aug 27, 2026 at 9:45 PM EDT..."
//
// so the display title can be rebuilt from it without a team-name table.
// Matching does not depend on this — that runs off the ticker — so a
// wording change here degrades the label, not the pairing.
function kalshiGameTitle(market) {
  const rules = String(market.rules_primary || "");
  const m = rules.match(
    /\bwins the\s+(.+?)\s+game\s+originally\s+scheduled\s+for\s+([A-Z][a-z]{2}\s+\d{1,2}),/i
  );
  if (!m) return null;
  // Trim the sport descriptor: "professional baseball", "Pro Basketball".
  const matchup = m[1].replace(/\s+(?:professional|pro)\s+\S+$/i, "").trim();
  if (!/\svs\s/i.test(matchup)) return null;
  // The date is part of the label, not decoration: a three-game series
  // produces three cards whose teams and sides are identical, and
  // without it they read as duplicated rows rather than three games.
  const side = market.yes_sub_title || market.title;
  const head = `${matchup} (${m[2]})`;
  return side ? `${head} — ${side}` : head;
}

// Kalshi's taker fee is quadratic in price and scaled by a per-series
// multiplier (0.5 on KXMLBGAME, absent-and-therefore-1 elsewhere). It
// lives on /series/<ticker>, not on the market, so it needs its own
// lookup — cached because it is static metadata and there are only a
// few dozen distinct series across everything we pair.
// Also the only source of the web URL's middle segment. Kalshi's market
// page is /markets/<series>/<event-slug>/<event-ticker>, and the
// event-slug is the SERIES title slugified — it appears on
// /series/<ticker> and nowhere on the market or the event. Verified
// against live pages: "Somaliland recognition" ->
// somaliland-recognition, "Professional Baseball Game" ->
// professional-baseball-game.
const seriesMetaCache = new Map();

function slugifySeriesTitle(title) {
  const t = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t || null;
}

async function seriesMeta(seriesTicker) {
  if (!seriesTicker) return { feeMultiplier: null, slug: null };
  if (seriesMetaCache.has(seriesTicker)) return seriesMetaCache.get(seriesTicker);

  let meta = { feeMultiplier: null, slug: null };
  try {
    const r = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`
    );
    if (r.ok) {
      const d = await r.json();
      const m = d.series?.fee_multiplier;
      // A missing multiplier means the standard rate, i.e. 1 - not
      // "no fee". Defaulting it to 0 would price every Kalshi leg as
      // free and manufacture edges.
      let mult = m == null ? 1 : Number(m);
      if (!isFinite(mult)) mult = 1;
      meta = { feeMultiplier: mult, slug: slugifySeriesTitle(d.series?.title) };
    }
  } catch { /* leave nulls; fees treat null as 1, URL falls back to search */ }

  seriesMetaCache.set(seriesTicker, meta);
  return meta;
}

const num = v => (v == null || v === "" ? null : (isFinite(Number(v)) ? Number(v) : null));

// Attach each row's per-series fee multiplier. Done as a pass over the
// finished rows rather than inside the row builders so the /series
// lookups happen once per distinct series instead of once per market —
// KXMLBGAME alone is 74 markets behind one series.
async function attachKalshiSeriesMeta(rows) {
  const series = [...new Set(rows.map(r => String(r.id).split("-")[0]).filter(Boolean))];
  const metas = new Map(
    await Promise.all(series.map(async t => [t, await seriesMeta(t)]))
  );
  for (const r of rows) {
    const m = metas.get(String(r.id).split("-")[0]) || {};
    r.fee_multiplier = m.feeMultiplier ?? null;
    r.series_slug    = m.slug ?? null;
  }
  return rows;
}

// ── Fetch Kalshi markets ───────────────────────────────────────
const KALSHI_SERIES = [
  { ticker: "KXWCGAME",    sport: "soccer"   },
  { ticker: "KXNBAGAME",   sport: "nba"      },
  { ticker: "KXNHLGAME",   sport: "nhl"      },
  { ticker: "KXMLBGAME",   sport: "mlb"      },
  { ticker: "KXBTC",       sport: "crypto"   },
  { ticker: "KXETH",       sport: "crypto"   },
  { ticker: "KXFED",       sport: "econ"     },
  { ticker: "KXCPI",       sport: "econ"     },
  { ticker: "KXRECESSION", sport: "econ"     },
  { ticker: "KXGDP",       sport: "econ"     },
  { ticker: "KXPRES",      sport: "politics" },
];

// ── Kalshi fetch by CATEGORY (politics/crypto) ─────────────────
//
// The hardcoded KALSHI_SERIES list works for sports and econ, where a
// handful of series covers the whole category. It does not generalize:
// Kalshi lists 2,248 politics series, of which our list had exactly one
// (KXPRES) — and that one is currently empty, so politics looked like a
// matching problem when it was really a fetching problem.
//
// Two API traps found the hard way:
//   - /markets?category=X ignores the filter and returns KXMVE parlay
//     junk, same as the undocumented default behaviour.
//   - /events?category=X ALSO ignores it — Crypto and Politics return
//     byte-identical results. Only /series?category=X actually filters.
//
// So: get the category's series tickers from /series, then paginate all
// open /events and keep the ones whose series_ticker is in that set.
// One pass covers any category and replaces per-series fan-out.
async function fetchKalshiByCategory(kalshiCategory, sportTag, maxPages = 25) {
  const sres = await fetch(
    `https://api.elections.kalshi.com/trade-api/v2/series?category=${encodeURIComponent(kalshiCategory)}`
  );
  if (!sres.ok) return { markets: [], pages: 0, seriesInCategory: 0 };
  const sdata = await sres.json();
  const tickers = new Set(
    (sdata.series || []).map(x => x.ticker).filter(Boolean)
  );
  if (!tickers.size) return { markets: [], pages: 0, seriesInCategory: 0 };

  const out = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const url = new URL("https://api.elections.kalshi.com/trade-api/v2/events");
    url.searchParams.set("status", "open");
    url.searchParams.set("limit", "200");
    url.searchParams.set("with_nested_markets", "true");
    if (cursor) url.searchParams.set("cursor", cursor);

    const r = await fetch(url);
    if (!r.ok) break;
    const d = await r.json();
    pages++;

    for (const ev of d.events || []) {
      if (!tickers.has(ev.series_ticker)) continue;
      for (const m of ev.markets || []) {
        if (!m.ticker || m.ticker.startsWith("KXMVE") || !m.title) continue;
        out.push({
          id:             m.ticker,
          platform:       "kalshi",
          title:          kalshiGameTitle(m) ||
                          (m.yes_sub_title ? `${m.title} — ${m.yes_sub_title}` : m.title),
          yes_price:      m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
          no_price:       m.yes_ask_dollars ? 1 - parseFloat(m.yes_ask_dollars) : null,
          volume:         parseFloat(m.volume_24h_fp || m.volume_fp || 0),
          // The real books. yes_price above is the ask, which is what
          // v1 has always stored as though it were a mid.
          bid:            num(m.yes_bid_dollars),
          ask:            num(m.yes_ask_dollars),
          // Kalshi's NO side is its own book, not 1 - yes.
          no_bid:         num(m.no_bid_dollars),
          no_ask:         num(m.no_ask_dollars),
          bid_size:       num(m.yes_bid_size_fp),
          ask_size:       num(m.yes_ask_size_fp),
          close_time:     m.close_time || null,
          sport_tag:      sportTag,
          event_ticker:   m.event_ticker || ev.event_ticker || m.ticker,
          side_label:     m.yes_sub_title || null,
          slug:           null,
          outcomes:       null,
          outcome_prices: null,
          updated_at:     Math.floor(Date.now() / 1000),
        });
      }
    }

    cursor = d.cursor;
    if (!cursor) break;
  }

  await attachKalshiSeriesMeta(out);
  return { markets: out, pages, seriesInCategory: tickers.size };
}

// Categories fetched by enumeration rather than a fixed series list.
const KALSHI_CATEGORIES = { politics: "Politics", crypto: "Crypto" };

async function fetchKalshiMarkets(sportFilter = "all") {
  // politics/crypto come from category enumeration, not the fixed
  // series list — see fetchKalshiByCategory for why.
  if (KALSHI_CATEGORIES[sportFilter]) {
    const res = await fetchKalshiByCategory(KALSHI_CATEGORIES[sportFilter], sportFilter);
    return res.markets;
  }

  const series = sportFilter === "all"
    ? KALSHI_SERIES
    : KALSHI_SERIES.filter(s => s.sport === sportFilter);

  const results = await Promise.all(
    series.map(async ({ ticker, sport }) => {
      const r = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=100&series_ticker=${ticker}`
      );
      if (!r.ok) return [];
      const d = await r.json();
      return (d.markets || [])
        .filter(m => m.ticker && !m.ticker.startsWith("KXMVE") && m.title)
        .map(m => ({
          id:             m.ticker,
          platform:       "kalshi",
          title:          kalshiGameTitle(m) ||
                          (m.yes_sub_title ? `${m.title} — ${m.yes_sub_title}` : m.title),
          yes_price:      m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
          no_price:       m.yes_ask_dollars ? 1 - parseFloat(m.yes_ask_dollars) : null,
          volume:         parseFloat(m.volume_24h_fp || m.volume_fp || 0),
          // The real books. yes_price above is the ask, which is what
          // v1 has always stored as though it were a mid.
          bid:            num(m.yes_bid_dollars),
          ask:            num(m.yes_ask_dollars),
          // Kalshi's NO side is its own book, not 1 - yes.
          no_bid:         num(m.no_bid_dollars),
          no_ask:         num(m.no_ask_dollars),
          bid_size:       num(m.yes_bid_size_fp),
          ask_size:       num(m.yes_ask_size_fp),
          close_time:     m.close_time || null,
          sport_tag:      sport,
          event_ticker:   m.event_ticker || m.ticker,
          side_label:     m.yes_sub_title || null,
          slug:           null,
          outcomes:       null,
          outcome_prices: null,
          updated_at:     Math.floor(Date.now() / 1000),
        }));
    })
  );
  return attachKalshiSeriesMeta(results.flat());
}

// Both Polymarket exchanges. Reads that filter platform = 'polymarket'
// silently exclude polymarket_us, which is how 30 successfully fetched
// US game markets produced zero US pairs.
const POLY_PLATFORMS = ["polymarket", POLY_US_PLATFORM];

// ── Fetch Polymarket US game markets ───────────────────────────
//
// Games are not returned by any Polymarket US list endpoint — 1,200
// events paged from /v1/events contain zero of them — so they have to be
// requested by slug. The slug is `aec-<league>-<away>-<home>-<date>`,
// using the same team codes AND the same order as polymarket.com, so
// the .com rows we already fetched supply the order and no second alias
// table is needed.
//
// Two requests per game (metadata for the outcome order, /bbo for the
// book and depth), which is why this is scoped to the games Kalshi
// actually lists rather than sweeping a schedule.
async function fetchPolymarketUsGames(kalshiRows, polyRows, sportTag) {
  const orderByKey = new Map();
  for (const pm of polyRows || []) {
    const pk = polyGameKey(pm.slug);
    if (pk) orderByKey.set(pk.key, pk.codes);
  }

  const wanted = new Map();
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const km of kalshiRows || []) {
    const kk = kalshiGameKey(km.id);
    if (!kk || kk.date < todayIso) continue;
    const codes = orderByKey.get(kk.key);
    if (!codes) continue; // no .com listing, so no known slug order
    wanted.set(kk.key, { codes, date: kk.date });
  }

  const out = [];
  const diagnostics = { requested: wanted.size, listed: 0, notListed: 0 };

  // Sequential rather than parallel: this is a courtesy poll of a
  // venue's public gateway, not a race.
  for (const { codes, date } of wanted.values()) {
    const row = await fetchUsGameMarket(sportTag, codes, date);
    if (row) { out.push({ ...row, sport_tag: sportTag }); diagnostics.listed++; }
    else diagnostics.notListed++;
  }

  return { markets: out, diagnostics };
}

// ── Fetch Polymarket markets ───────────────────────────────────
const POLY_TAGS = [
  { tag: "100350", sport: "soccer" },
  { tag: "745",    sport: "nba"    },
  { tag: "899",    sport: "nhl"    },
  { tag: "100381", sport: "mlb"    },
  { tag: "129",    sport: "econ"   }, // federal reserve
  { tag: "131",    sport: "econ"   }, // interest rates (rate-level questions, vs "federal reserve"'s hike-count ones)
  { tag: "101249", sport: "econ"   }, // Macro Inflation (CPI)
  { tag: "100201", sport: "econ"   }, // recession
  { tag: "370",    sport: "econ"   }, // GDP
  { tag: "21",     sport: "crypto"   }, // Crypto
  { tag: "1312",   sport: "crypto"   }, // Crypto Prices
  { tag: "2",      sport: "politics" }, // Politics
];

// Sports that use structured team matching (not embeddings). Also used
// below to scope a sports-only event filter: an event with more than a
// few markets is almost always a tournament-winner futures listing, not
// an individual game, which is a fair assumption for sports but not for
// everything else - a Fed decision, for instance, can legitimately have
// more than 4 rate-bucket outcomes. Non-sports tags skip that filter and
// let embedding similarity do the filtering instead.
const SPORTS_TAGS = new Set(["mlb", "nba", "nhl", "soccer"]);

async function fetchPolymarkets(sportFilter = "all") {
  const tags = sportFilter === "all"
    ? POLY_TAGS
    : POLY_TAGS.filter(t => t.sport === sportFilter);

  const results = await Promise.all(
    tags.map(async ({ tag, sport }) => {
      const events = [];
      let offset = 0;
      while (offset < 600) {
        const r = await fetch(
          `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tag}&limit=50&offset=${offset}`
        );
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) break;
        events.push(...data);
        if (data.length < 50) break;
        offset += 50;
      }

      return events
        .filter(e => {
          if (Array.isArray(e.teams)) return e.teams.length === 2;
          if (SPORTS_TAGS.has(sport)) return (e.markets || []).length <= 4;
          return true;
        })
        .flatMap(e => {
          const mktList = e.markets || [];
          const moneyline = mktList.filter(m => m.sportsMarketType === "moneyline");
          const toUse = moneyline.length > 0 ? moneyline : mktList;
          return toUse.map(m => {
            let yes_price = null;
            let no_price = null;
            try {
              const prices = JSON.parse(m.outcomePrices || "[]");
              yes_price = prices[0] != null ? parseFloat(prices[0]) : null;
              no_price  = prices[1] != null ? parseFloat(prices[1]) : null;
            } catch { /* ignore */ }
            return {
              id:             m.id,
              platform:       "polymarket",
              title:          m.question || e.title || "",
              yes_price,
              no_price,
              volume:         parseFloat(m.volumeNum || m.volume || 0),
              // Polymarket quotes one book per market, on outcome 0.
              // The other outcome is its exact complement in a binary
              // CLOB, so it is derived at read time rather than stored
              // twice — see lib/fees.js complementBook.
              bid:            num(m.bestBid),
              ask:            num(m.bestAsk),
              // {rate, exponent, takerOnly, rebateRate}. Null when the
              // market predates fees or has them disabled, which the
              // fee model reads as genuinely zero.
              fee_schedule:   m.feesEnabled && m.feeSchedule ? m.feeSchedule : null,
              close_time:     null,
              sport_tag:      sport,
              slug:           e.slug || m.slug || null,
              event_ticker:   null,
              side_label:     m.groupItemTitle || null,
              outcomes:       m.outcomes || null,
              outcome_prices: m.outcomePrices || null,
              updated_at:     Math.floor(Date.now() / 1000),
            };
          });
        });
    })
  );
  return results.flat();
}

// Delete every pair whose Kalshi side is in `kalshiIds`, in chunks.
//
// PostgREST puts .in() values in the query string, so one call with the
// 1,774 Kalshi ids politics now has builds a ~40KB URL and the request
// dies before it reaches the table. supabase-js returns that as an
// unchecked error object, and the call sites ignored it, so clearing
// looked like it worked: a re-match at a corrected threshold wrote its
// new pairs and left every stale wrong one in place. That is why the
// live site kept showing "Trump buy Greenland" against "Trump visit
// Greenland by December 31" long after the run that should have
// removed it.
//
// Chunked so the URL stays short, and errors are returned rather than
// swallowed.
async function clearPairsForKalshiIds(kalshiIds) {
  const errors = [];
  let cleared = 0;
  for (let i = 0; i < kalshiIds.length; i += 200) {
    const chunk = kalshiIds.slice(i, i + 200);
    const { error, count } = await supabase
      .from("pairs")
      .delete({ count: "exact" })
      .in("kalshi_id", chunk);
    if (error) errors.push(`clearPairs: ${error.message || JSON.stringify(error)}`);
    else cleared += count || 0;
  }
  return { cleared, errors };
}

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  const force     = req.query.force     === "1";
  const matchOnly = req.query.matchonly === "1";
  // Inspect a threshold/gate change without touching the pairs table.
  // Iterating on thresholds against the live table once wrote 71 wrong
  // crypto pairs to production before they could be reviewed; matchonly
  // deletes and rewrites by default, so "just looking" needs its own flag.
  const dryRun   = req.query.dry       === "1";
  const sport     = req.query.sport || "all";
  // Per-category similarity floor.
  //
  // 0.78 suits econ, where extractNumericClaim() carries most of the
  // precision and similarity only has to generate candidates. Politics
  // and crypto have NO numeric claim in most titles, so that gate is
  // inert and embedding score is the only thing deciding — and embeddings
  // do not distinguish "buy Greenland" from "visit Greenland", "nuclear
  // deal" from "declare war", or "receive a pardon" from "charged".
  //
  // An audit of politics at 0.78 found ~7 correct pairs out of 30. At
  // 0.94 only the genuinely-duplicate cluster survives (the Venezuela
  // head-of-state set, 0.947-0.963) and every audited false positive is
  // excluded.
  //
  // This is a blunt instrument standing in for a missing gate, not a
  // fix: it buys precision by discarding real matches that happen to be
  // worded differently. The real fix is a claim gate that understands
  // predicates and deadlines — see docs/architecture-v2.md.
  // Per-category similarity floors. Politics titles are near-verbatim
  // across venues when they match at all, so 0.94 is where the noise
  // stops. Crypto sits lower because Kalshi phrases every strike as
  // "<COIN> trimmed mean be above $X" against Polymarket's "Will <Coin>
  // reach $X" — real matches land around 0.91-0.93, and the dollar-strike
  // and deadline gates, not the score, are what reject the near-misses.
  // Below 0.90 the "positive return in 2026" family starts pairing with
  // unrelated strike markets, which no current gate catches.
  // Crypto drops to 0.88 now that strikePresenceCompatible exists. The
  // floor sat at 0.90 to keep out Kalshi's "positive return in 2026"
  // family, which carries no threshold and so passed every gate — that
  // family is now rejected on claim asymmetry rather than on score.
  // 0.88 is what the real matches need: the genuine Kalshi/Polymarket US
  // overlap, "above $199,999.99" against "above $200,000 in 2026",
  // scores 0.890 and was missing the cut by a hundredth.
  const CATEGORY_THRESHOLDS = { politics: 0.94, crypto: 0.88 };
  const THRESHOLD = parseFloat(
    req.query.threshold || CATEGORY_THRESHOLDS[sport] || "0.78"
  );

  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  try {
    if (matchOnly) {
      // MATCH-ONLY MODE: re-run matching on already-stored markets
      const sportFilter = sport === "all" ? null : sport;

      const buildKalshi = () => {
        let q = supabase
          .from("markets")
          .select("id, title, sport_tag, embedding, side_label, close_time")
          .eq("platform", "kalshi");
        if (sportFilter) q = q.eq("sport_tag", sportFilter);
        return q;
      };
      // Real errors, not a hardcoded null. `readErrors` was declared as
      // `const kalshiReadError = null` and could therefore never report
      // anything, which is what let a silently-failing read look like an
      // empty category.
      const readErrors = [];
      const kalshiDb = await fetchAllRows(buildKalshi, { errors: readErrors });

      // Scope by sport_tag like the Kalshi query above - an unscoped
      // select silently caps at Supabase's default 1000-row limit, which
      // can truncate before reaching the requested category's rows at
      // all as the table grows across more sports/categories.
      const buildPoly = () => {
        let q = supabase
          .from("markets")
          .select("id, platform, title, sport_tag, embedding, side_label, outcomes, outcome_prices, slug")
          .in("platform", POLY_PLATFORMS);
        if (sportFilter) q = q.eq("sport_tag", sportFilter);
        return q;
      };
      const polyDb = await fetchAllRows(buildPoly, { errors: readErrors });

      // Clear existing pairs for this sport
      let clearResult = { cleared: 0, errors: [] };
      if (dryRun) {
        // skip: dry runs must leave the pairs table exactly as they found it
      } else if (sportFilter) {
        const kalshiIds = (kalshiDb || []).map(m => m.id);
        if (kalshiIds.length > 0) {
          clearResult = await clearPairsForKalshiIds(kalshiIds);
        }
      } else if (force) {
        const { error } = await supabase.from("pairs").delete().neq("id", 0);
        if (error) clearResult.errors.push(`clearPairs(all): ${error.message}`);
      }

      let newPairs = [];
      let matchDiagnostics = null;

      if (sportFilter && SPORTS_TAGS.has(sportFilter)) {
        // Use structured team-name matching for sports
        const sportResult = matchSportsMarkets(kalshiDb || [], polyDb || [], sportFilter);
        newPairs = sportResult.newPairs;
        matchDiagnostics = sportResult.matchDiagnostics;
      } else {
        // pgvector first: the database compares the vectors and returns
        // only ids and scores, so the ~20KB-a-row embeddings never cross
        // the wire. Falls back to the JS matcher when migration 0007 has
        // not been run.
        const db = sportFilter ? await candidatesFromDb(sportFilter) : null;

        if (db && db.rows) {
          const byId = new Map();
          for (const m of [...(kalshiDb || []), ...(polyDb || [])]) byId.set(String(m.id), m);
          const result = matchFromDbCandidates(db.rows, byId, THRESHOLD);
          newPairs = result.newPairs;
          matchDiagnostics = { ...result.matchDiagnostics, dbCandidates: db.rows.length };
        } else {
          const result = matchNonSportsMarkets(kalshiDb, polyDb, THRESHOLD);
          newPairs = result.newPairs;
          matchDiagnostics = {
            ...result.matchDiagnostics,
            ...(db && db.error ? { rpcError: db.error } : {}),
          };
        }
      }

      const pairsUpsert = (newPairs.length > 0 && !dryRun)
        ? await upsertRows("pairs", newPairs, "kalshi_id,polymarket_id")
        : { count: 0, errors: [] };

      const { count } = await supabase
        .from("pairs")
        .select("*", { count: "exact", head: true });

      return res.status(200).json({
        mode:        dryRun ? "match-only (dry)" : "match-only",
        dryRun,
        sport,
        newPairs:    newPairs.length,
        totalPairs:  count || 0,
        kalshiCount: (kalshiDb || []).length,
        polyCount:   (polyDb || []).length,
        pairsUpserted: pairsUpsert.count,
        pairsCleared: clearResult.cleared,
        pairsErrors: [...clearResult.errors, ...pairsUpsert.errors].slice(0, 5),
        readErrors,
        ...(matchDiagnostics ? { matchDiagnostics } : {}),
      });
    }

    // NORMAL MODE: fetch markets, store in Supabase, then match
    const [kalshiRaw, polyRaw] = await Promise.all([
      fetchKalshiMarkets(sport),
      fetchPolymarkets(sport),
    ]);

    // Polymarket US is a separate exchange with its own books, and a US
    // account can only trade that one — so its games are fetched
    // alongside .com's rather than instead of them, and each game pairs
    // against whichever venues list it.
    let usGames = { markets: [], diagnostics: null };
    if (SPORTS_TAGS.has(sport)) {
      usGames = await fetchPolymarketUsGames(kalshiRaw, polyRaw, sport);
    } else if (sport !== "all") {
      // Non-sports US markets DO come back from the list endpoints, so
      // these arrive in bulk rather than one slug at a time. They are
      // where a tradeable edge would actually show up for a US account:
      // every non-sports pair the site has surfaced so far sits on
      // polymarket.com, which a US trader cannot touch.
      const us = await fetchPolymarketUs();
      const rows = us.markets.map(toMarketRow).filter(r => r && r.sport_tag === sport);
      usGames = {
        markets: rows,
        diagnostics: { fetched: us.markets.length, forCategory: rows.length, errors: us.errors.slice(0, 3) },
      };
    }

    const allMarkets = [...kalshiRaw, ...polyRaw, ...usGames.markets];

    // Find markets not yet in Supabase
    // Paged. As a plain select this capped at 1000 ids, so every market
    // beyond the first thousand looked new on every run — re-embedding
    // the entire catalogue each time (thousands of needless Voyage
    // calls) and growing the table without bound.
    // "Already embedded", not "already stored". Keying off mere
    // existence meant a row stored by one run and embedded by none
    // stayed unembedded forever: the next run saw the id, skipped it,
    // and the matcher — which reads only rows with an embedding — never
    // saw it. That is exactly what happened to the 257 Polymarket US
    // politics and econ markets, which were ingested and then invisible.
    //
    // Selecting on embedding IS NOT NULL makes the set mean what the
    // filter below assumes, and re-embeds anything that lost or never
    // got one. Sports rows are excluded regardless, so they do not churn.
    const existing = await fetchAllRows(() => supabase
      .from("markets").select("id").not("embedding", "is", null));
    const embeddedIds = new Set((existing || []).map(r => r.id));
    const toEmbed = force
      ? allMarkets.filter(m => !SPORTS_TAGS.has(m.sport_tag))
      : allMarkets.filter(m => !embeddedIds.has(m.id) && !SPORTS_TAGS.has(m.sport_tag));

    // Upsert all markets. Deliberately not touching `embedding` here -
    // omitting the key from the payload leaves it untouched for rows
    // that already have one, instead of wiping every existing embedding
    // on every non-force run. The follow-up embedding upsert below sets
    // it for whichever rows are actually being (re-)embedded this run.
    const toUpsert = allMarkets;
    const marketsUpsert = await upsertRows("markets", toUpsert, "id");

    // Embed only non-sports markets (sports use structured matching)
    let embedded = 0;
    let embeddingUpsert = { count: 0, errors: [] };
    if (toEmbed.length > 0) {
      const titles = toEmbed.map(m => m.title);
      const embeddings = await embedTitles(titles);
      // Keep the full row (already in memory from the fetch step above,
      // and just written by the upsert above that) rather than sending
      // only {id, embedding, updated_at} - an upsert still validates
      // NOT NULL columns like `platform` on the attempted insert row
      // even when the row already exists and conflict resolution will
      // just update it, so a partial payload fails every time.
      // Both columns. `embedding_v` (migration 0007) is the vector the
      // database matches on; `embedding` is the original JSON, kept
      // until the vector path has proven itself on real matches.
      //
      // pgvector parses the same bracketed form JSON.stringify produces,
      // so one string serves both — no separate encoding to drift.
      const records = toEmbed.map((m, i) => {
        const encoded = JSON.stringify(embeddings[i]);
        return {
          ...m,
          embedding: encoded,
          embedding_v: encoded,
          updated_at: Math.floor(Date.now() / 1000),
        };
      });
      embeddingUpsert = await upsertRows("markets", records, "id");
      embedded = toEmbed.length;
    }

    // Run matching
    const clearErrors = [];
    let newPairs = [];
    let matchDiagnostics = null;
    const isSport = sport !== "all" && SPORTS_TAGS.has(sport);

    if (isSport) {
      // Structured team matching for sports
      // Paged, like the non-sports branch. Without this the select
      // stopped at Supabase's server-side 1000-row cap, and `markets`
      // holds every fixture ever stored — so sports matched whichever
      // thousand rows came back first, which was old finished games,
      // and every pair it wrote was then dropped by markets.js's
      // expired-date filter. The site showed an empty Sports tab while
      // the discovery job reported 66 new pairs.
      const kalshiDb = await fetchAllRows(() => supabase
        .from("markets").select("id, title, sport_tag, side_label, close_time")
        .eq("platform", "kalshi").eq("sport_tag", sport));
      const polyDb = await fetchAllRows(() => supabase
        .from("markets").select("id, platform, title, sport_tag, side_label, outcomes, outcome_prices, slug")
        .in("platform", POLY_PLATFORMS).eq("sport_tag", sport));

      // Clear existing pairs for this sport before re-matching
      const kalshiIds = (kalshiDb || []).map(m => m.id);
      if (kalshiIds.length > 0) {
        clearErrors.push(...(await clearPairsForKalshiIds(kalshiIds)).errors);
      }

      const sportResult = matchSportsMarkets(kalshiDb || [], polyDb || [], sport);
      newPairs = sportResult.newPairs;
      matchDiagnostics = sportResult.matchDiagnostics;
    } else {
      // Embedding matching for non-sports
      // Explicit limits: the implicit 1000-row cap silently truncated
      // matching once politics/crypto pushed these tables past 12k rows,
      // which showed up as a category matching in matchonly mode but
      // producing zero pairs in normal mode.
      // Scoped to the requested category. Unscoped, a run for one
      // category matched every category: `sport=econ` returned 325
      // "econ pairs" that were the aliens, Somaliland and Venezuela
      // politics pairs. matchNonSportsMarkets only requires
      // k.sport_tag === p.sport_tag, not that either equals the
      // category asked for, so every embedded row in the table was in
      // play. The pairs written were individually correct, which is why
      // this hid — but newPairs meant nothing per category, the run did
      // many times the work requested, and pair clearing (which IS
      // scoped) no longer matched what the run wrote.
      const scoped = q => (sport === "all" ? q : q.eq("sport_tag", sport));
      const kalshiDb = await fetchAllRows(() => scoped(supabase
        .from("markets").select("id, title, sport_tag, embedding")
        .eq("platform", "kalshi").not("embedding", "is", null)));
      const polyDb = await fetchAllRows(() => scoped(supabase
        .from("markets").select("id, title, sport_tag, embedding")
        .in("platform", POLY_PLATFORMS).not("embedding", "is", null)));

      // Clear existing pairs for this sport before re-matching. Missing
      // this meant stale pairs (e.g. wrong-threshold matches from
      // before the numeric-signature gate existed) never got replaced -
      // upsert only overwrites a row when both kalshi_id AND
      // polymarket_id match, so a kalshi row matching a *different*
      // Polymarket market this run just adds a second row instead of
      // replacing the old wrong one.
      const kalshiIdsForSport = (kalshiDb || [])
        .filter(m => sport === "all" || m.sport_tag === sport)
        .map(m => m.id);
      if (kalshiIdsForSport.length > 0) {
        clearErrors.push(...(await clearPairsForKalshiIds(kalshiIdsForSport)).errors);
      }

      const result = matchNonSportsMarkets(kalshiDb, polyDb, THRESHOLD);
      newPairs = result.newPairs;
      matchDiagnostics = result.matchDiagnostics;
    }

    const pairsUpsert = newPairs.length > 0
      ? await upsertRows("pairs", newPairs, "kalshi_id,polymarket_id")
      : { count: 0, errors: [] };

    const { count } = await supabase
      .from("pairs").select("*", { count: "exact", head: true });

    res.status(200).json({
      embedded,
      newPairs:    newPairs.length,
      totalKalshi: kalshiRaw.length,
      totalPoly:   polyRaw.length,
      totalPolyUs: usGames.markets.length,
      ...(usGames.diagnostics ? { polyUsDiagnostics: usGames.diagnostics } : {}),
      totalPairs:  count || 0,
      writes: {
        marketsUpserted: marketsUpsert.count,
        marketsErrors: marketsUpsert.errors.slice(0, 5),
        embeddingUpserted: embeddingUpsert.count,
        embeddingErrors: embeddingUpsert.errors.slice(0, 5),
        pairsUpserted: pairsUpsert.count,
        pairsErrors: [...clearErrors, ...pairsUpsert.errors].slice(0, 5),
      },
      ...(matchDiagnostics ? { matchDiagnostics } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}