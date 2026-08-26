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
// CORRECTION, and the reason the next part matters: an earlier version
// of this comment claimed .us lists no per-game markets, "589 live MLB
// markets, every one a future". That was wrong. It came from paginating
// /v1/markets and /v1/events and finding none — but GAME markets are
// not returned by the list endpoints at all. 1,200 events paged from
// /v1/events contain zero `aec-` tickers, while a direct lookup of
// aec-mlb-mil-nym-2026-08-27 returns a live book immediately.
//
// So games are reachable ONLY by direct slug lookup, and any future
// attempt to enumerate them from a list endpoint will conclude they do
// not exist. They do.
//
// Public market data needs no key: gateway.polymarket.us. The
// authenticated api.polymarket.us is for trading and is not used here.
const GATEWAY = "https://gateway.polymarket.us/v1";

// A plain, honest client identifier. The gateway does not require one —
// it answers with any User-Agent or none — but naming ourselves to a
// venue we poll on a schedule is the polite default.
//
// NOTE for anyone testing this from a sandbox: a 403 whose body reads
// "Host not in allowlist: gateway.polymarket.us" is the local egress
// proxy, NOT Polymarket. It says nothing about this code. Verify with
// curl (which is proxied differently) or in a deployed environment.
const UA = "housedge/1.0 (+https://housedge.vercel.app)";
const usFetch = (url) => fetch(url, { headers: { "User-Agent": UA } });

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
      const r = await usFetch(url);
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


// ── Games ──────────────────────────────────────────────────────
// Game slugs are `aec-<league>-<away>-<home>-<yyyy-mm-dd>`, and the team
// codes are the same ones polymarket.com uses in its own slugs — so a
// .us slug can be rebuilt from a .com slug (or from a Kalshi game key)
// without a second alias table:
//
//   .com   mlb-mil-nym-2026-08-27
//   .us    aec-mlb-mil-nym-2026-08-27
//
// The order matters and matches .com's, which is also the order of
// `outcomes`, so the existing outcome-index logic carries over.
//
// US appears to list games only a couple of days out: Aug 26 and Aug 27
// fixtures resolved, Aug 28 did not. A 404 here means "not listed yet",
// not "wrong slug", and must not be treated as an error.
export function usGameSlug(league, codes, isoDate) {
  if (!league || !Array.isArray(codes) || codes.length !== 2 || !isoDate) return null;
  return `aec-${league}-${codes[0].toLowerCase()}-${codes[1].toLowerCase()}-${isoDate}`;
}

// Best bid/offer WITH depth. This is the one thing polymarket.com does
// not publish — Gamma exposes aggregate liquidity but no size at the
// touch — so every Polymarket leg has had `depthKnown: false` and an
// upper bound taken from the Kalshi side alone. Here both sides are
// real, which makes a US pair the first one that can be sized honestly.
export async function fetchUsBbo(slug) {
  try {
    const r = await usFetch(`${GATEWAY}/markets/${encodeURIComponent(slug)}/bbo`);
    if (r.status === 404) return { notListed: true };
    if (!r.ok) return { error: `bbo ${r.status}` };

    const d = (await r.json()).marketData || {};
    const px = v => (v && v.value != null && isFinite(Number(v.value)) ? Number(v.value) : null);
    return {
      bid: px(d.bestBid),
      ask: px(d.bestAsk),
      bidDepth: Number(d.bidDepth) || null,
      askDepth: Number(d.askDepth) || null,
      lastTrade: px(d.lastTradePx),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Polymarket US prices its own taker fee off `feeCoefficient` on the
// market (0.06 on the MLB game checked), which is NOT the same as
// polymarket.com's feeSchedule.rate of 0.05. Read it per market rather
// than assuming the two venues charge alike.
export function usFeeSchedule(market) {
  const rate = Number(market.feeCoefficient);
  return isFinite(rate) && rate > 0 ? { rate, exponent: 1, takerOnly: true } : null;
}
