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

async function upsertRows(table, rows, onConflict, batchSize = 50) {
  const errors = [];
  let count = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await restFetch(`${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(batch),
    });
    if (error) errors.push(JSON.stringify(error));
    else count += batch.length;
  }
  return { count, errors };
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

// ── Shared embedding-based matcher for non-sports markets ────────
// Used by both matchonly and normal mode so they can't drift apart -
// they duplicated this logic separately for a while this session and
// it caused real bugs (a diagnostic added to one branch and forgotten
// in the other).
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
  candidates.sort((a, b) => b.score - a.score);

  const usedKalshi = new Set();
  const usedPoly = new Set();
  const newPairs = [];
  const acceptedPairs = [];

  for (const c of candidates) {
    if (usedKalshi.has(c.km.id) || usedPoly.has(c.pm.id)) continue;
    newPairs.push({
      kalshi_id:     c.km.id,
      polymarket_id: c.pm.id,
      similarity:    c.score,
      created_at:    Math.floor(Date.now() / 1000),
    });
    acceptedPairs.push({ score: c.score, kalshi: c.km.title, poly: c.pm.title });
    usedKalshi.add(c.km.id);
    usedPoly.add(c.pm.id);
  }

  topScores.sort((a, b) => b.score - a.score);
  acceptedPairs.sort((a, b) => b.score - a.score);

  return {
    newPairs,
    matchDiagnostics: {
      threshold,
      kalshiEmbeddedCount: (kalshiDb || []).filter(m => m.embedding).length,
      polyEmbeddedCount: polyEmbedded.length,
      acceptedPairs: acceptedPairs.slice(0, 100),
      // Uncapped (bounded only by kalshiDb size) rather than top-10 -
      // the top of the list is dominated by one cluster (e.g. GDP
      // buckets), which hides whether other categories (CPI, Fed rate)
      // have real candidates further down.
      topScores,
    },
  };
}

// ── MLB team name map ──────────────────────────────────────────
// Maps every Kalshi abbreviation AND common short form to canonical
// full team name. Both platforms' titles get normalized through this
// before comparison, so "Chicago C" and "Chicago Cubs" both become
// "chicago cubs" and match exactly.
const MLB_TEAMS = {
  // Kalshi single-letter suffixes
  "los angeles a":   "los angeles angels",
  "los angeles d":   "los angeles dodgers",
  "new york y":      "new york yankees",
  "new york m":      "new york mets",
  "chicago c":       "chicago cubs",
  "chicago w":       "chicago white sox",
  // City-only forms (Kalshi often omits nickname)
  "arizona":         "arizona diamondbacks",
  "atlanta":         "atlanta braves",
  "baltimore":       "baltimore orioles",
  "boston":          "boston red sox",
  "cincinnati":      "cincinnati reds",
  "cleveland":       "cleveland guardians",
  "colorado":        "colorado rockies",
  "detroit":         "detroit tigers",
  "houston":         "houston astros",
  "kansas city":     "kansas city royals",
  "miami":           "miami marlins",
  "milwaukee":       "milwaukee brewers",
  "minnesota":       "minnesota twins",
  "oakland":         "oakland athletics",
  "philadelphia":    "philadelphia phillies",
  "pittsburgh":      "pittsburgh pirates",
  "san diego":       "san diego padres",
  "san francisco":   "san francisco giants",
  "seattle":         "seattle mariners",
  "st. louis":       "st. louis cardinals",
  "st louis":        "st. louis cardinals",
  "tampa bay":       "tampa bay rays",
  "texas":           "texas rangers",
  "toronto":         "toronto blue jays",
  "washington":      "washington nationals",
  // Full names (already correct, included for normalization)
  "los angeles angels":      "los angeles angels",
  "los angeles dodgers":     "los angeles dodgers",
  "new york yankees":        "new york yankees",
  "new york mets":           "new york mets",
  "chicago cubs":            "chicago cubs",
  "chicago white sox":       "chicago white sox",
  "arizona diamondbacks":    "arizona diamondbacks",
  "atlanta braves":          "atlanta braves",
  "baltimore orioles":       "baltimore orioles",
  "boston red sox":          "boston red sox",
  "cincinnati reds":         "cincinnati reds",
  "cleveland guardians":     "cleveland guardians",
  "colorado rockies":        "colorado rockies",
  "detroit tigers":          "detroit tigers",
  "houston astros":          "houston astros",
  "kansas city royals":      "kansas city royals",
  "miami marlins":           "miami marlins",
  "milwaukee brewers":       "milwaukee brewers",
  "minnesota twins":         "minnesota twins",
  "oakland athletics":       "oakland athletics",
  "philadelphia phillies":   "philadelphia phillies",
  "pittsburgh pirates":      "pittsburgh pirates",
  "san diego padres":        "san diego padres",
  "san francisco giants":    "san francisco giants",
  "seattle mariners":        "seattle mariners",
  "st. louis cardinals":     "st. louis cardinals",
  "tampa bay rays":          "tampa bay rays",
  "texas rangers":           "texas rangers",
  "toronto blue jays":       "toronto blue jays",
  "washington nationals":    "washington nationals",
  // Common alternates
  "athletics":               "oakland athletics",
  "a's":                     "oakland athletics",
  "ath":                     "oakland athletics",
};

// Extract the canonical team name from a fragment of text
function normalizeTeam(text) {
  const t = text.toLowerCase().trim();
  // Try longest match first
  const sorted = Object.keys(MLB_TEAMS).sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (t.includes(key)) return MLB_TEAMS[key];
  }
  return t;
}

// Extract both teams from a Kalshi MLB title
// Kalshi format: "Team A vs Team B Winner? — Side"
function extractKalshiTeams(title) {
  const lower = title.toLowerCase();
  const vsMatch = lower.match(/^(.+?)\s+vs\s+(.+?)\s+(winner|game)/i);
  if (!vsMatch) return null;
  return {
    team1: normalizeTeam(vsMatch[1].trim()),
    team2: normalizeTeam(vsMatch[2].trim()),
  };
}

// Extract both teams from a Polymarket MLB title
// Polymarket format: "Team A vs. Team B" or "Will Team A win on DATE?"
function extractPolyTeams(title) {
  const lower = title.toLowerCase();
  // "Team A vs. Team B" format
  const vsMatch = lower.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*:|$)/i);
  if (vsMatch) {
    return {
      team1: normalizeTeam(vsMatch[1].trim()),
      team2: normalizeTeam(vsMatch[2].trim()),
    };
  }
  // "Will Team A win on DATE?" format
  const willMatch = lower.match(/will\s+(.+?)\s+win/i);
  if (willMatch) {
    return { team1: normalizeTeam(willMatch[1].trim()), team2: null };
  }
  return null;
}

// Check if two team sets match (both teams must appear in both titles)
function teamsMatch(kTeams, pTeams) {
  if (!kTeams || !pTeams) return false;
  const kSet = new Set([kTeams.team1, kTeams.team2].filter(Boolean));
  const pSet = new Set([pTeams.team1, pTeams.team2].filter(Boolean));
  // Both teams from Kalshi must appear in Polymarket's teams
  let matches = 0;
  for (const t of kSet) {
    if (pSet.has(t)) matches++;
  }
  return matches >= Math.min(kSet.size, pSet.size);
}

// Extract YYYY-MM-DD from a string (slug, close_time, ticker, etc.)
// Handles multiple formats:
//   - ISO: "2026-07-19T22:40:00Z" → "2026-07-19"
//   - Slug: "mlb-stl-laa-2026-07-19-..." → "2026-07-19"
//   - Kalshi ticker: "KXMLBGAME-26JUL191915CWSTOR" → "2026-07-19"
const MONTH_MAP = {
  JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
  JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"
};

function extractDate(str) {
  if (!str) return null;
  const s = String(str).toUpperCase();

  // Try ISO format first: 2026-07-19
  const isoMatch = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1].toLowerCase();

  // Try Kalshi ticker format: 26JUL19 → 2026-07-19
  const tickerMatch = s.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/);
  if (tickerMatch) {
    const year = `20${tickerMatch[1]}`;
    const month = MONTH_MAP[tickerMatch[2]];
    const day = tickerMatch[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return null;
}

// Check if two dates are close enough to be the same game
// 6-hour window handles UTC/ET differences for games listed near midnight
// but blocks yesterday's completed game from matching tomorrow's game
function datesCompatible(d1, d2) {
  if (!d1 || !d2) return true; // if either date missing, don't block
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  return Math.abs(t1 - t2) <= 21600000; // max 6 hours apart
}

// ── Sports-specific structured matching ────────────────────────
// Extracts team names from both sides and requires BOTH to match.
// Also checks game date to prevent matching same teams on different days.
function matchSportsMarkets(kalshiMarkets, polyMarkets, sportTag) {
  const matched = [];
  const usedPolyIds = new Set();

  for (const km of kalshiMarkets) {
    const kTeams = extractKalshiTeams(km.title || "");
    if (!kTeams) continue;

    // Extract Kalshi game date from ticker (most reliable — always present)
    // e.g. "KXMLBGAME-26JUL191915CWSTOR" → "2026-07-19"
    const kDate = extractDate(km.id) || extractDate(km.close_time);

    let bestMatch = null;
    let bestScore = 0;

    for (const pm of polyMarkets) {
      if (usedPolyIds.has(pm.id)) continue;
      if (pm.sport_tag !== sportTag) continue;

      const pTeams = extractPolyTeams(pm.title || "");
      if (!teamsMatch(kTeams, pTeams)) continue;

      // Extract Polymarket game date from slug
      const pDate = extractDate(pm.slug);

      // HARD GATE: dates must be within 1 day of each other
      // Prevents "Cardinals vs Angels tomorrow" matching
      // "Cardinals vs Angels today" — same teams, wrong game
      if (!datesCompatible(kDate, pDate)) continue;

      const isMoneyline = !pm.title.toLowerCase().includes("inning") &&
                          !pm.title.toLowerCase().includes("o/u") &&
                          !pm.title.toLowerCase().includes("tied") &&
                          !pm.title.toLowerCase().includes("score");

      // Score = moneyline bonus + date proximity bonus
      // Prefer the candidate whose date is closest to Kalshi's game date
      const dateDiff = (kDate && pDate)
        ? Math.abs(new Date(kDate).getTime() - new Date(pDate).getTime())
        : Infinity;
      const dateScore = dateDiff === Infinity ? 0 : 1 - (dateDiff / 86400000);
      const score = (isMoneyline ? 1.0 : 0.9) + (dateScore * 0.1);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = pm;
      }
    }

    if (bestMatch) {
      matched.push({
        kalshi_id:     km.id,
        polymarket_id: bestMatch.id,
        similarity:    bestScore,
        created_at:    Math.floor(Date.now() / 1000),
      });
      usedPolyIds.add(bestMatch.id);
    }
  }

  return matched;
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
          title:          m.yes_sub_title ? `${m.title} — ${m.yes_sub_title}` : m.title,
          yes_price:      m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
          no_price:       m.yes_ask_dollars ? 1 - parseFloat(m.yes_ask_dollars) : null,
          volume:         parseFloat(m.volume_24h_fp || m.volume_fp || 0),
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
          title:          m.yes_sub_title ? `${m.title} — ${m.yes_sub_title}` : m.title,
          yes_price:      m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
          no_price:       m.yes_ask_dollars ? 1 - parseFloat(m.yes_ask_dollars) : null,
          volume:         parseFloat(m.volume_24h_fp || m.volume_fp || 0),
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
  return results.flat();
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

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  const force     = req.query.force     === "1";
  const matchOnly = req.query.matchonly === "1";
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
  const CATEGORY_THRESHOLDS = { politics: 0.94, crypto: 0.94 };
  const THRESHOLD = parseFloat(
    req.query.threshold || CATEGORY_THRESHOLDS[sport] || "0.78"
  );

  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  try {
    if (matchOnly) {
      // MATCH-ONLY MODE: re-run matching on already-stored markets
      const sportFilter = sport === "all" ? null : sport;

      let kalshiQuery = supabase
        .from("markets")
        .select("id, title, sport_tag, embedding, side_label, close_time")
        .eq("platform", "kalshi")
      if (sportFilter) kalshiQuery = kalshiQuery.eq("sport_tag", sportFilter);
      const { data: kalshiDb, error: kalshiReadError } = await kalshiQuery;

      // Scope by sport_tag like the Kalshi query above - an unscoped
      // select silently caps at Supabase's default 1000-row limit, which
      // can truncate before reaching the requested category's rows at
      // all as the table grows across more sports/categories.
      let polyQuery = supabase
        .from("markets")
        .select("id, title, sport_tag, embedding, side_label, outcomes, outcome_prices, slug")
        .eq("platform", "polymarket")
        .limit(5000);
      if (sportFilter) polyQuery = polyQuery.eq("sport_tag", sportFilter);
      const { data: polyDb, error: polyReadError } = await polyQuery;

      const readErrors = [kalshiReadError, polyReadError].filter(Boolean).map(e => e.message);

      // Clear existing pairs for this sport
      if (sportFilter) {
        const kalshiIds = (kalshiDb || []).map(m => m.id);
        if (kalshiIds.length > 0) {
          await supabase.from("pairs").delete().in("kalshi_id", kalshiIds);
        }
      } else if (force) {
        await supabase.from("pairs").delete().neq("id", 0);
      }

      let newPairs = [];
      let matchDiagnostics = null;

      if (sportFilter && SPORTS_TAGS.has(sportFilter)) {
        // Use structured team-name matching for sports
        newPairs = matchSportsMarkets(
          kalshiDb || [],
          polyDb || [],
          sportFilter
        );
      } else {
        // Use embedding-based matching for non-sports
        const result = matchNonSportsMarkets(kalshiDb, polyDb, THRESHOLD);
        newPairs = result.newPairs;
        matchDiagnostics = result.matchDiagnostics;
      }

      const pairsUpsert = newPairs.length > 0
        ? await upsertRows("pairs", newPairs, "kalshi_id,polymarket_id")
        : { count: 0, errors: [] };

      const { count } = await supabase
        .from("pairs")
        .select("*", { count: "exact", head: true });

      return res.status(200).json({
        mode:        "match-only",
        sport,
        newPairs:    newPairs.length,
        totalPairs:  count || 0,
        kalshiCount: (kalshiDb || []).length,
        polyCount:   (polyDb || []).length,
        pairsUpserted: pairsUpsert.count,
        pairsErrors: pairsUpsert.errors.slice(0, 5),
        readErrors,
        ...(matchDiagnostics ? { matchDiagnostics } : {}),
      });
    }

    // NORMAL MODE: fetch markets, store in Supabase, then match
    const [kalshiRaw, polyRaw] = await Promise.all([
      fetchKalshiMarkets(sport),
      fetchPolymarkets(sport),
    ]);
    const allMarkets = [...kalshiRaw, ...polyRaw];

    // Find markets not yet in Supabase
    const { data: existing } = await supabase.from("markets").select("id");
    const existingIds = new Set((existing || []).map(r => r.id));
    const toEmbed = force
      ? allMarkets.filter(m => !SPORTS_TAGS.has(m.sport_tag))
      : allMarkets.filter(m => !existingIds.has(m.id) && !SPORTS_TAGS.has(m.sport_tag));

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
      const records = toEmbed.map((m, i) => ({
        ...m,
        embedding: JSON.stringify(embeddings[i]),
        updated_at: Math.floor(Date.now() / 1000),
      }));
      embeddingUpsert = await upsertRows("markets", records, "id");
      embedded = toEmbed.length;
    }

    // Run matching
    let newPairs = [];
    let matchDiagnostics = null;
    const isSport = sport !== "all" && SPORTS_TAGS.has(sport);

    if (isSport) {
      // Structured team matching for sports
      const { data: kalshiDb } = await supabase
        .from("markets").select("id, title, sport_tag, side_label, close_time")
        .eq("platform", "kalshi").eq("sport_tag", sport);
      const { data: polyDb } = await supabase
        .from("markets").select("id, title, sport_tag, side_label, outcomes, outcome_prices, slug")
        .eq("platform", "polymarket").eq("sport_tag", sport);

      // Clear existing pairs for this sport before re-matching
      const kalshiIds = (kalshiDb || []).map(m => m.id);
      if (kalshiIds.length > 0) {
        await supabase.from("pairs").delete().in("kalshi_id", kalshiIds);
      }

      newPairs = matchSportsMarkets(kalshiDb || [], polyDb || [], sport);
    } else {
      // Embedding matching for non-sports
      const { data: kalshiDb } = await supabase
        .from("markets").select("id, title, sport_tag, embedding")
        .eq("platform", "kalshi").not("embedding", "is", null);
      const { data: polyDb } = await supabase
        .from("markets").select("id, title, sport_tag, embedding")
        .eq("platform", "polymarket").not("embedding", "is", null);

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
        await supabase.from("pairs").delete().in("kalshi_id", kalshiIdsForSport);
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
      totalPairs:  count || 0,
      writes: {
        marketsUpserted: marketsUpsert.count,
        marketsErrors: marketsUpsert.errors.slice(0, 5),
        embeddingUpserted: embeddingUpsert.count,
        embeddingErrors: embeddingUpsert.errors.slice(0, 5),
        pairsUpserted: pairsUpsert.count,
        pairsErrors: pairsUpsert.errors.slice(0, 5),
      },
      ...(matchDiagnostics ? { matchDiagnostics } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}