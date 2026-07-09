// Category definitions mirrored from the frontend — keep in sync.
// (In a future cleanup pass, this should live in one shared file.)
const CATEGORIES = {
  sports: {
    // Each series/tag tagged with its specific sport — sports are NOT
    // interchangeable within the "Sports" tab. MLB must only match MLB,
    // NBA only NBA, etc. Without this, "Los Angeles Dodgers" (MLB) was
    // matching "Los Angeles Angels" (also MLB, but wrong team) AND
    // worse, cross-sport collisions like baseball matching basketball
    // when city names overlapped (both have a "New York" team).
    kalshiSeriesBySport: {
      // Each sport needs BOTH the GAME ticker (individual matchups, what
      // we actually want to compare) and the championship/futures ticker
      // (kept for potential future use, e.g. matching against Polymarket
      // tournament-winner markets in a separate "futures" view). Discovered
      // via: curl ".../v2/series?category=Sports" | grep -i mlbgame etc —
      // Kalshi follows a consistent KX{SPORT}GAME naming pattern.
      soccer: ["KXWCGAME"],
      nba: ["KXNBAGAME"],
      nhl: ["KXNHLGAME"],
      mlb: ["KXMLBGAME"],
    },
    polyTagsBySport: {
      soccer: ["100350"],
      nba: ["745"],
      nhl: ["899"],
      mlb: ["100381"],
    },
  },
  economics: {
    kalshiSeriesBySport: { econ: ["KXFED", "KXCPI", "KXRECESSION", "KXGDP"] },
    polyTagsBySport: { econ: ["370"] },
  },
  crypto: {
    kalshiSeriesBySport: { crypto: ["KXBTC", "KXETH"] },
    polyTagsBySport: { crypto: [] }, // TODO: look up via /tags endpoint
  },
  politics: {
    kalshiSeriesBySport: { politics: ["KXPRES"] },
    polyTagsBySport: { politics: [] }, // TODO: look up via /tags endpoint
  },
};

async function fetchKalshiBySport(seriesList, sportTag) {
  const promises = seriesList.map(s =>
    fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=50&series_ticker=${s}`)
      .then(r => r.ok ? r.json() : { markets: [] })
      .then(d => d.markets || [])
      .catch(() => [])
  );
  const results = await Promise.all(promises);
  return results.flat()
    .filter(m =>
      m.ticker &&
      !m.ticker.startsWith("KXMVE") &&
      m.title &&
      !m.title.startsWith("yes ") &&
      !m.title.includes(",yes ")
    )
    .map(m => ({ ...m, sportTag }));
}

async function fetchPolyEventsByTag(tagId) {
  const allEvents = [];
  let offset = 0;
  const limit = 50;

  while (offset < 600) {
    const r = await fetch(
      `https://gamma-api.polymarket.com/events?active=true&closed=false&tag_id=${tagId}&limit=${limit}&offset=${offset}`
    );
    if (!r.ok) break;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    allEvents.push(...data);
    if (data.length < limit) break;
    offset += limit;
  }
  return allEvents;
}

async function fetchPolyBySport(tagIds, sportTag) {
  if (!tagIds || tagIds.length === 0) return [];
  const results = await Promise.all(tagIds.map(fetchPolyEventsByTag));
  const seen = new Map();
  for (const event of results.flat()) {
    if (!seen.has(event.id)) seen.set(event.id, event);
  }
  const events = Array.from(seen.values());

  // RELIABLE individual-game signal: prefer the `teams` array (exactly 2
  // entries = head-to-head game) when present — this is accurate for
  // MLB/NBA/NHL events which bundle moneyline+spread+totals together
  // (6+ markets for ONE real game, which a market-count filter wrongly
  // excludes as if it were a tournament future). Soccer events may not
  // carry a `teams` field the same way, so fall back to the market-count
  // heuristic (2-4 markets) for those.
  return events
    .filter(e => {
      if (Array.isArray(e.teams)) return e.teams.length === 2;
      const count = (e.markets || []).length;
      return count >= 1 && count <= 4;
    })
    .flatMap(e => {
      const eventMarkets = e.markets || [];
      // When an event has a sportsMarketType field, prefer the basic
      // moneyline market (who wins outright) over spread/total variants
      // — moneyline is the closest equivalent to Kalshi's single
      // "Team A wins?" structure. Fall back to all markets otherwise.
      const moneylineMarkets = eventMarkets.filter(m => m.sportsMarketType === "moneyline");
      const marketsToUse = moneylineMarkets.length > 0 ? moneylineMarkets : eventMarkets;

      return marketsToUse.map(m => ({
        ...m,
        eventTitle: e.title,
        question: m.question || `${e.title} — ${m.groupItemTitle || ""}`,
        sportTag, // tag with sub-category so cross-sport matching is blocked
      }));
    });
}

export default async function handler(req, res) {
  try {
    const categoryKey = req.query.category || "sports";
    const cat = CATEGORIES[categoryKey];

    if (!cat) {
      return res.status(400).json({ error: `Unknown category: ${categoryKey}` });
    }

    const sportTags = Object.keys(cat.kalshiSeriesBySport);
    const hasAnyPolyTags = sportTags.some(s => (cat.polyTagsBySport[s] || []).length > 0);

    if (!hasAnyPolyTags) {
      return res.status(200).json({ kalshi: [], poly: [], unsupported: true });
    }

    const kalshiPromises = sportTags.map(sportTag =>
      fetchKalshiBySport(cat.kalshiSeriesBySport[sportTag], sportTag)
    );
    const polyPromises = sportTags.map(sportTag =>
      fetchPolyBySport(cat.polyTagsBySport[sportTag], sportTag)
    );

    const [kalshiResults, polyResults] = await Promise.all([
      Promise.all(kalshiPromises),
      Promise.all(polyPromises),
    ]);

    res.setHeader("Cache-Control", "s-maxage=60");
    res.status(200).json({
      kalshi: kalshiResults.flat(),
      poly: polyResults.flat(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}