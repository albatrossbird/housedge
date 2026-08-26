// Polymarket US — a separate venue, not a mirror of polymarket.com.
//
// polymarket.com and polymarket.us are different exchanges with
// different market sets, different slugs, and different books. A US
// account can only trade the .us one, so pricing a Kalshi leg against
// a .com book produces an edge the reader cannot take.
//
// Verified on the same claim, same moment:
//
//   Kalshi         Bitcoin above $199,999.99 by Dec 31 2026   0.03 / 0.04
//   Polymarket US  Bitcoin above $200k by 12/31/2026          0.05
//
// and .us lists no per-game MLB moneylines at all (589 live MLB
// markets, every one a future), which is the whole sports tab.
//
// Public market data needs no key: gateway.polymarket.us. The
// authenticated api.polymarket.us is for trading and is not used here.
const GATEWAY = "https://gateway.polymarket.us/v1";

export const POLY_US_PLATFORM = "polymarket_us";

export function polyUsUrl(slug) {
  return slug ? `https://polymarket.us/event/${slug}` : "https://polymarket.us/";
}

// The strike lives in the SLUG, not the question. Polymarket US
// templates a whole family under one title —
//
//   question  "Will Bitcoin be above ___ in 2026?"
//   slug      cpc-btc-above-yr-12-31-2026-200k
//
// — so the title alone cannot distinguish the $200k market from the
// $250k one. Every scalar gate in lib/v2/claims.js reads titles, so the
// strike has to be put back into the title for them to work at all.
// Without this the two would look identical and pair interchangeably,
// which is exactly the bucket problem the gates exist to stop.
const STRIKE_RE = /-(\d+(?:\.\d+)?)(k|m)?$/i;

export function synthesizeTitle(market) {
  const q = String(market.question || "");
  if (!q.includes("___")) return q;

  const m = String(market.slug || "").match(STRIKE_RE);
  if (!m) return q;

  let value = parseFloat(m[1]);
  if (!isFinite(value)) return q;
  if (m[2]) value *= (m[2].toLowerCase() === "k" ? 1e3 : 1e6);

  const formatted = `$${value.toLocaleString("en-US")}`;
  return q.replace("___", formatted);
}

// outcomes and outcomePrices are NOT reliably aligned here either: a
// market with outcomes ["No","Yes"] came back with prices
// ["0.0400","0.97"] where 0.04 is the YES price. `marketSides` pairs a
// description with its own price explicitly, so read that and treat the
// parallel arrays as a fallback only.
export function sidePrices(market) {
  const sides = Array.isArray(market.marketSides) ? market.marketSides : [];
  let yes = null, no = null;

  for (const s of sides) {
    const px = Number(s.price);
    if (!isFinite(px)) continue;
    const label = String(s.description || "").toLowerCase();
    if (s.long === true || label === "yes") yes = px;
    else if (s.long === false || label === "no") no = px;
  }

  if (yes == null && no != null) yes = Math.round((1 - no) * 10000) / 10000;
  if (no == null && yes != null) no = Math.round((1 - yes) * 10000) / 10000;
  return { yes, no };
}

export async function fetchPolymarketUs({ maxPages = 20, pageSize = 200 } = {}) {
  const out = [];
  const errors = [];

  for (let page = 0; page < maxPages; page++) {
    const url = `${GATEWAY}/markets?limit=${pageSize}&offset=${page * pageSize}&closed=false`;
    let data;
    try {
      const r = await fetch(url);
      if (!r.ok) { errors.push(`gateway ${r.status}`); break; }
      data = await r.json();
    } catch (err) {
      errors.push(`fetch: ${err.message}`);
      break;
    }

    const rows = data.markets || [];
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  // The gateway pages by offset over a set that includes duplicates
  // across pages; dedupe on id rather than trusting the paging.
  return { markets: [...new Map(out.map(m => [String(m.id), m])).values()], errors };
}

// Which of our categories a US market belongs to. Its own `category` is
// close but not identical to v1's sport_tag vocabulary.
export function sportTagFor(market) {
  const c = String(market.category || "").toLowerCase();
  if (c === "crypto") return "crypto";
  if (c === "politics" || c === "geopolitics") return "politics";
  if (c === "macro" || c === "finance") return "econ";
  if (c !== "sports") return null;

  const slug = String(market.slug || "");
  if (/-mlb-/.test(slug)) return "mlb";
  if (/-nba-/.test(slug)) return "nba";
  if (/-nhl-/.test(slug)) return "nhl";
  if (/-(mls|epl|ucl|soccer)-/.test(slug)) return "soccer";
  return null;
}
