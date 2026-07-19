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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// ── Sports-specific structured matching ────────────────────────
// Extracts team names from both sides and requires BOTH to match.
// This replaces embedding-based matching for sports since short
// matchup titles don't give embeddings enough semantic signal to
// reliably distinguish "Cardinals vs Angels" from "Cardinals vs Diamondbacks".
function matchSportsMarkets(kalshiMarkets, polyMarkets, sportTag) {
  const matched = [];
  const usedPolyIds = new Set();

  for (const km of kalshiMarkets) {
    const kTeams = extractKalshiTeams(km.title || "");
    if (!kTeams) continue;

    let bestMatch = null;
    let bestScore = 0;

    for (const pm of polyMarkets) {
      if (usedPolyIds.has(pm.id)) continue;
      if (pm.sport_tag !== sportTag) continue;

      const pTeams = extractPolyTeams(pm.title || "");
      if (!teamsMatch(kTeams, pTeams)) continue;

      // Teams match — score by how many markets share both teams
      // (prefer moneyline over prop bets for same matchup)
      const isMoneyline = !pm.title.toLowerCase().includes("inning") &&
                          !pm.title.toLowerCase().includes("o/u") &&
                          !pm.title.toLowerCase().includes("tied") &&
                          !pm.title.toLowerCase().includes("score");
      const score = isMoneyline ? 1.0 : 0.9;

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

async function fetchKalshiMarkets(sportFilter = "all") {
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
];

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

// Sports that use structured team matching (not embeddings)
const SPORTS_TAGS = new Set(["mlb", "nba", "nhl", "soccer"]);

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  const force     = req.query.force     === "1";
  const matchOnly = req.query.matchonly === "1";
  const sport     = req.query.sport || "all";
  const THRESHOLD = parseFloat(req.query.threshold || "0.78");

  try {
    if (matchOnly) {
      // MATCH-ONLY MODE: re-run matching on already-stored markets
      const sportFilter = sport === "all" ? null : sport;

      let kalshiQuery = supabase
        .from("markets")
        .select("id, title, sport_tag, embedding, side_label")
        .eq("platform", "kalshi")
      if (sportFilter) kalshiQuery = kalshiQuery.eq("sport_tag", sportFilter);
      const { data: kalshiDb } = await kalshiQuery;

      const { data: polyDb } = await supabase
        .from("markets")
        .select("id, title, sport_tag, embedding, side_label, outcomes, outcome_prices, slug")
        .eq("platform", "polymarket");

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

      if (sportFilter && SPORTS_TAGS.has(sportFilter)) {
        // Use structured team-name matching for sports
        newPairs = matchSportsMarkets(
          kalshiDb || [],
          polyDb || [],
          sportFilter
        );
      } else {
        // Use embedding-based matching for non-sports
        const usedPolyIds = new Set();
        const polyEmbedded = (polyDb || [])
          .filter(m => m.embedding)
          .map(m => ({ ...m, _vec: JSON.parse(m.embedding) }));

        for (const km of (kalshiDb || [])) {
          if (!km.embedding) continue;
          const kVec = JSON.parse(km.embedding);
          let bestMatch = null;
          let bestScore = 0;

          for (const pm of polyEmbedded) {
            if (usedPolyIds.has(pm.id)) continue;
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
        mode:        "match-only",
        sport,
        newPairs:    newPairs.length,
        totalPairs:  count || 0,
        kalshiCount: (kalshiDb || []).length,
        polyCount:   (polyDb || []).length,
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

    // Upsert all markets (with or without embedding)
    const toUpsert = allMarkets.map(m => ({
      ...m,
      embedding: null, // will be updated below for non-sports
    }));
    for (let i = 0; i < toUpsert.length; i += 50) {
      await supabase.from("markets").upsert(toUpsert.slice(i, i + 50), { onConflict: "id" });
    }

    // Embed only non-sports markets (sports use structured matching)
    let embedded = 0;
    if (toEmbed.length > 0) {
      const titles = toEmbed.map(m => m.title);
      const embeddings = await embedTitles(titles);
      const records = toEmbed.map((m, i) => ({
        id: m.id,
        embedding: JSON.stringify(embeddings[i]),
        updated_at: Math.floor(Date.now() / 1000),
      }));
      for (let i = 0; i < records.length; i += 50) {
        await supabase.from("markets").upsert(records.slice(i, i + 50), { onConflict: "id" });
      }
      embedded = toEmbed.length;
    }

    // Run matching
    let newPairs = [];
    const isSport = sport !== "all" && SPORTS_TAGS.has(sport);

    if (isSport) {
      // Structured team matching for sports
      const { data: kalshiDb } = await supabase
        .from("markets").select("id, title, sport_tag, side_label")
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

      const usedPolyIds = new Set();
      const polyEmbedded = (polyDb || []).map(m => ({ ...m, _vec: JSON.parse(m.embedding) }));

      for (const km of (kalshiDb || [])) {
        const kVec = JSON.parse(km.embedding);
        let bestMatch = null;
        let bestScore = 0;
        for (const pm of polyEmbedded) {
          if (usedPolyIds.has(pm.id)) continue;
          if (km.sport_tag !== pm.sport_tag) continue;
          const score = cosineSimilarity(kVec, pm._vec);
          if (score > bestScore && score >= THRESHOLD) {
            bestScore = score;
            bestMatch = pm;
          }
        }
        if (bestMatch) {
          newPairs.push({ kalshi_id: km.id, polymarket_id: bestMatch.id, similarity: bestScore, created_at: Math.floor(Date.now() / 1000) });
          usedPolyIds.add(bestMatch.id);
        }
      }
    }

    if (newPairs.length > 0) {
      for (let i = 0; i < newPairs.length; i += 50) {
        await supabase.from("pairs").upsert(newPairs.slice(i, i + 50), { onConflict: "kalshi_id,polymarket_id" });
      }
    }

    const { count } = await supabase
      .from("pairs").select("*", { count: "exact", head: true });

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
