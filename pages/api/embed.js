// pages/api/embed.js
// Embedding + matching engine using Voyage AI + Supabase
// 
// USAGE:
//   /api/embed?sport=mlb     — embed + match MLB only
//   /api/embed?sport=soccer  — embed + match soccer only
//   /api/embed?sport=nba     — embed + match NBA only
//   /api/embed?sport=nhl     — embed + match NHL only
//   /api/embed?sport=all     — embed everything (may timeout on Vercel)
//   /api/embed?force=1       — re-embed even already-stored markets
//
// Run one sport at a time to stay within Vercel's 60s timeout.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Voyage AI embedding ────────────────────────────────────────
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
        model: "voyage-3.5-lite",
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

// ── Team name expansion map ────────────────────────────────────
// Kalshi abbreviates same-city teams with a single letter suffix
// (e.g. "Los Angeles A" for Angels, "Chicago C" for Cubs). The
// embedding model can't distinguish these from other LA/Chicago teams
// since the disambiguating letter gets lost in a short title.
// Expanding to full names BEFORE embedding fixes this at the root —
// "St. Louis vs Los Angeles A" → "St. Louis Cardinals vs Los Angeles Angels"
// now correctly produces a different vector from
// "St. Louis Cardinals vs Arizona Diamondbacks".
const TEAM_EXPANSIONS = {
  // MLB — same-city teams with letter suffix
  "los angeles a":  "Los Angeles Angels",
  "los angeles d":  "Los Angeles Dodgers",
  "new york y":     "New York Yankees",
  "new york m":     "New York Mets",
  "chicago c":      "Chicago Cubs",
  "chicago w":      "Chicago White Sox",
  // Common Kalshi city-only abbreviations → full team names
  "st. louis":      "St. Louis Cardinals",
  "san francisco":  "San Francisco Giants",
  "san diego":      "San Diego Padres",
  "kansas city":    "Kansas City Royals",
  "tampa bay":      "Tampa Bay Rays",
  "arizona":        "Arizona Diamondbacks",
  "colorado":       "Colorado Rockies",
  "miami":          "Miami Marlins",
  "milwaukee":      "Milwaukee Brewers",
  "minnesota":      "Minnesota Twins",
  "pittsburgh":     "Pittsburgh Pirates",
  "cincinnati":     "Cincinnati Reds",
  "cleveland":      "Cleveland Guardians",
  "detroit":        "Detroit Tigers",
  "toronto":        "Toronto Blue Jays",
  "seattle":        "Seattle Mariners",
  "oakland":        "Oakland Athletics",
  "texas":          "Texas Rangers",
  "houston":        "Houston Astros",
  "baltimore":      "Baltimore Orioles",
  "boston":         "Boston Red Sox",
  "washington":     "Washington Nationals",
  "philadelphia":   "Philadelphia Phillies",
  "atlanta":        "Atlanta Braves",
};

function expandTeamNames(title) {
  let expanded = title;
  for (const [abbr, full] of Object.entries(TEAM_EXPANSIONS)) {
    // Case-insensitive whole-word replacement
    const regex = new RegExp(`\\b${abbr}\\b`, "gi");
    expanded = expanded.replace(regex, full);
  }
  return expanded;
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

async function fetchKalshiMarkets(sportFilter = "all") {
  const series = sportFilter === "all"
    ? KALSHI_SERIES
    : KALSHI_SERIES.filter(s => s.sport === sportFilter);

  const results = await Promise.all(
    KALSHI_SERIES.map(async ({ ticker, sport }) => {
      const r = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=100&series_ticker=${ticker}`
      );
      if (!r.ok) return [];
      const d = await r.json();
      return (d.markets || [])
        .filter(m => m.ticker && !m.ticker.startsWith("KXMVE") && m.title)
        .map(m => ({
          id:           m.ticker,
          platform:     "kalshi",
          title:        expandTeamNames(m.yes_sub_title ? `${m.title} — ${m.yes_sub_title}` : m.title),
          yes_price:    m.yes_ask_dollars ? parseFloat(m.yes_ask_dollars) : null,
          no_price:     m.yes_ask_dollars ? 1 - parseFloat(m.yes_ask_dollars) : null,
          volume:       parseFloat(m.volume_24h_fp || m.volume_fp || 0),
          close_time:   m.close_time || null,
          sport_tag:    sport,
          event_ticker: m.event_ticker || m.ticker,
          side_label:   m.yes_sub_title || null,
          slug:         null,
          outcomes:     null,
          outcome_prices: null,
          updated_at:   Math.floor(Date.now() / 1000),
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
];

async function fetchPolymarkets(sportFilter = "all") {
  const tags = sportFilter === "all"
    ? POLY_TAGS
    : POLY_TAGS.filter(t => t.sport === sportFilter);

  const results = await Promise.all(
    POLY_TAGS.map(async ({ tag, sport }) => {
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
        .filter(e => Array.isArray(e.teams) ? e.teams.length === 2 : (e.markets || []).length <= 4)
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
  const THRESHOLD = parseFloat(req.query.threshold || "0.75");

  try {
    // MATCH-ONLY MODE: skip embedding, just re-run cosine similarity
    // on markets already stored in Supabase. Use this after changing
    // the threshold or to re-pair markets without re-embedding.
    // Usage: /api/embed?matchonly=1&sport=mlb&threshold=0.75
    if (matchOnly) {
      const sportFilter = sport === "all" ? null : sport;

      let kalshiQuery = supabase
        .from("markets")
        .select("id, title, sport_tag, embedding")
        .eq("platform", "kalshi")
        .not("embedding", "is", null);
      if (sportFilter) kalshiQuery = kalshiQuery.eq("sport_tag", sportFilter);
      const { data: kalshiDb } = await kalshiQuery;

      const { data: polyDb } = await supabase
        .from("markets")
        .select("id, title, sport_tag, embedding")
        .eq("platform", "polymarket")
        .not("embedding", "is", null);

      // Clear existing pairs for this sport so we can re-match cleanly
      if (sportFilter) {
        const kalshiIds = (kalshiDb || []).map(m => m.id);
        if (kalshiIds.length > 0) {
          await supabase.from("pairs").delete().in("kalshi_id", kalshiIds);
        }
      } else if (force) {
        await supabase.from("pairs").delete().neq("id", 0);
      }

      const usedPolyIds = new Set();
      const newPairs = [];

      const polyEmbedded = (polyDb || []).map(m => ({
        ...m,
        _vec: JSON.parse(m.embedding),
      }));

      for (const km of (kalshiDb || [])) {
        const kVec = JSON.parse(km.embedding);
        let bestMatch = null;
        let bestScore = 0;

        for (const pm of polyEmbedded) {
          if (usedPolyIds.has(pm.id)) continue;

          // HARD GATE: sport tags must match exactly — embeddings alone
          // can't reliably distinguish "A's vs Arizona" (MLB) from
          // "New York City FC vs LA FC" (soccer) when titles are short
          // and share city names. Sport tag is always reliable since it
          // comes from the specific API series/tag we fetched from.
          if (km.sport_tag !== pm.sport_tag) continue;

          const score = cosineSimilarity(kVec, pm._vec);
          if (score > bestScore && score >= THRESHOLD) {
            bestScore = score;
            bestMatch = pm;
          }
        }

        if (bestMatch) {
          newPairs.push({
            kalshi_id:     km.id,
            polymarket_id: bestMatch.id,
            similarity:    bestScore,
            created_at:    Math.floor(Date.now() / 1000),
          });
          usedPolyIds.add(bestMatch.id);
        }
      }

      if (newPairs.length > 0) {
        for (let i = 0; i < newPairs.length; i += 50) {
          await supabase.from("pairs").upsert(newPairs.slice(i, i + 50), {
            onConflict: "kalshi_id,polymarket_id",
          });
        }
      }

      const { count } = await supabase
        .from("pairs")
        .select("*", { count: "exact", head: true });

      return res.status(200).json({
        mode:       "match-only",
        sport,
        threshold:  THRESHOLD,
        kalshiCount: (kalshiDb || []).length,
        polyCount:   (polyDb || []).length,
        newPairs:    newPairs.length,
        totalPairs:  count || 0,
      });
    }

    // NORMAL MODE: fetch markets, embed new ones, then match
    const [kalshiRaw, polyRaw] = await Promise.all([
      fetchKalshiMarkets(sport),
      fetchPolymarkets(sport),
    ]);
    const allMarkets = [...kalshiRaw, ...polyRaw];

    // 2. Find which markets are already in Supabase
    const { data: existing } = await supabase
      .from("markets")
      .select("id");
    const existingIds = new Set((existing || []).map(r => r.id));

    // 3. Determine which markets need embedding
    const toEmbed = force
      ? allMarkets
      : allMarkets.filter(m => !existingIds.has(m.id));

    // 4. Embed new markets in batches
    let embedded = 0;
    if (toEmbed.length > 0) {
      const titles = toEmbed.map(m => m.title);
      const embeddings = await embedTitles(titles);

      const records = toEmbed.map((m, i) => ({
        ...m,
        embedding: JSON.stringify(embeddings[i]),
      }));

      // Upsert in batches of 50 to avoid Supabase payload limits
      for (let i = 0; i < records.length; i += 50) {
        const batch = records.slice(i, i + 50);
        await supabase.from("markets").upsert(batch, { onConflict: "id" });
      }
      embedded = toEmbed.length;
    }

    // 5. Update prices for ALL markets (even existing ones)
    const priceUpdates = allMarkets.map(m => ({
      id:         m.id,
      yes_price:  m.yes_price,
      no_price:   m.no_price,
      volume:     m.volume,
      updated_at: Math.floor(Date.now() / 1000),
    }));
    for (let i = 0; i < priceUpdates.length; i += 50) {
      await supabase.from("markets").upsert(priceUpdates.slice(i, i + 50), { onConflict: "id" });
    }

    // 6. Load all markets with embeddings for matching
    const { data: kalshiDb } = await supabase
      .from("markets")
      .select("*")
      .eq("platform", "kalshi")
      .not("embedding", "is", null);

    const { data: polyDb } = await supabase
      .from("markets")
      .select("*")
      .not("embedding", "is", null)
      .eq("platform", "polymarket");

    // 7. Find already-paired Kalshi IDs
    const { data: existingPairs } = await supabase
      .from("pairs")
      .select("kalshi_id, polymarket_id");

    const pairedKalshiIds = new Set((existingPairs || []).map(p => p.kalshi_id));
    const usedPolyIds     = new Set((existingPairs || []).map(p => p.polymarket_id));

    const kalshiToMatch = force
      ? (kalshiDb || [])
      : (kalshiDb || []).filter(m => !pairedKalshiIds.has(m.id));

    const polyEmbedded = (polyDb || []).map(m => ({
      ...m,
      _vec: JSON.parse(m.embedding),
    }));

    // 8. Match via cosine similarity
    const newPairs = [];

    for (const km of kalshiToMatch) {
      const kVec = JSON.parse(km.embedding);
      let bestMatch = null;
      let bestScore = 0;

      for (const pm of polyEmbedded) {
        if (usedPolyIds.has(pm.id)) continue;

        // HARD GATE: sport tags must match exactly
        if (km.sport_tag !== pm.sport_tag) continue;

        const score = cosineSimilarity(kVec, pm._vec);
        if (score > bestScore && score >= THRESHOLD) {
          bestScore = score;
          bestMatch = pm;
        }
      }

      if (bestMatch) {
        newPairs.push({
          kalshi_id:     km.id,
          polymarket_id: bestMatch.id,
          similarity:    bestScore,
          created_at:    Math.floor(Date.now() / 1000),
        });
        usedPolyIds.add(bestMatch.id);
      }
    }

    if (newPairs.length > 0) {
      await supabase.from("pairs").upsert(newPairs, { onConflict: "kalshi_id,polymarket_id" });
    }

    // 9. Get total pair count
    const { count } = await supabase
      .from("pairs")
      .select("*", { count: "exact", head: true });

    res.status(200).json({
      embedded,
      newPairs:    newPairs.length,
      totalKalshi: kalshiRaw.length,
      totalPoly:   polyRaw.length,
      totalPairs:  count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
