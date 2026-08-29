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
  const q = String(market.question || "").trim();
  // `titleShort` is the market's own side label — "Above 2.5%",
  // "$200,000", "Cut", "Jon Ossoff (D)" — and every one of the 5,877
  // non-sports US markets carries one.
  const short = String(market.titleShort || "").replace(/\s+/g, " ").trim();

  // "Will Bitcoin be above ___ in 2026?" — the placeholder families.
  // titleShort already holds the strike in display form, so prefer it
  // and keep the slug parse as the fallback it always was.
  if (q.includes("___")) {
    if (short) return q.replace("___", short);
    const m = String(market.slug || "").match(STRIKE_RE);
    if (!m) return q;
    let value = parseFloat(m[1]);
    if (!isFinite(value)) return q;
    if (m[2]) value *= (m[2].toLowerCase() === "k" ? 1e3 : 1e6);
    return q.replace("___", `$${value.toLocaleString("en-US")}`);
  }

  // Everything else in a templated family shares ONE question: all six
  // GDP strikes are "US GDP Growth in Q3 2026?", every candidate in a
  // race is "Who will win ...?". 5,866 of 5,877 non-sports US markets
  // share a question with a sibling, so without the side label the
  // whole catalogue collapses to ~1,062 distinct titles and the scalar
  // gates have nothing to tell family members apart with. That is why
  // crypto matched exactly one family (the ___ case above, the only one
  // this function used to handle) and politics matched nothing at all.
  //
  // The em-dash form mirrors how Kalshi writes its own side labels
  // ("... in Q3 2026? — Above 3.0%"), which is also the shape the
  // extractors in lib/v2/claims.js already read.
  if (!short) return q;
  if (/^(yes|no)$/i.test(short)) return q;             // binary: adds nothing
  if (q.toLowerCase().includes(short.toLowerCase())) return q;  // already stated
  return `${q} — ${short}`;
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

// Polymarket US lists ~20,500 live markets. The original 20 x 200 = 4,000
// ceiling covered a fifth of them, and I then used that partial set to
// conclude the two venues do not overlap outside sports — with politics
// showing 191 markets where there are 2,469, and macro 2 where there
// are 85. Page size is the maximum the gateway accepts and the ceiling
// leaves room to grow.
export async function fetchPolymarketUs({ maxPages = 60, pageSize = 500, concurrency = 6 } = {}) {
  const out = [];
  const errors = [];

  // Paged in waves rather than one request at a time.
  //
  // Sixty sequential pages is most of a politics discovery run's budget
  // before it has fetched anything else, and every non-sports category
  // pays it to keep the handful of markets that belong to it. With the
  // fetch that slow, the run hit Vercel's 300s ceiling and returned no
  // body at all - the category could not be rebuilt.
  //
  // Waves keep the early-stop: a short page means the catalogue ended,
  // so the wave containing it is the last one worth issuing.
  for (let page = 0; page < maxPages; page += concurrency) {
    const wave = [];
    for (let i = 0; i < concurrency && page + i < maxPages; i++) {
      const offset = (page + i) * pageSize;
      wave.push(
        usFetch(`${GATEWAY}/markets?limit=${pageSize}&offset=${offset}&closed=false`)
          .then(async r => {
            if (!r.ok) return { error: `gateway ${r.status}`, rows: [] };
            const data = await r.json();
            return { rows: data.markets || [] };
          })
          .catch(err => ({ error: `fetch: ${err.message}`, rows: [] }))
      );
    }

    const results = await Promise.all(wave);
    let ended = false;
    for (const r of results) {
      if (r.error) { errors.push(r.error); ended = true; continue; }
      out.push(...r.rows);
      if (r.rows.length < pageSize) ended = true;
    }
    if (ended) break;
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


// One game's tradable state on Polymarket US: metadata for the outcome
// order, plus the book for prices and depth. Two calls because /bbo
// carries the book but not the outcomes, and /markets?slug= carries the
// outcomes but only last-trade prices.
//
// Returns null when the game is not listed (US publishes only a couple
// of days ahead), which is a normal state and not an error.
export async function fetchUsGameMarket(league, codes, isoDate) {
  const slug = usGameSlug(league, codes, isoDate);
  if (!slug) return null;

  let market;
  try {
    const r = await usFetch(`${GATEWAY}/markets?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    market = ((await r.json()).markets || [])[0];
  } catch { return null; }
  if (!market || market.closed) return null;

  const bbo = await fetchUsBbo(slug);
  if (!bbo || bbo.notListed || bbo.error) return null;

  let outcomes = null;
  try { outcomes = JSON.parse(market.outcomes); } catch { /* leave null */ }

  return {
    id: slug,                      // the slug IS the venue's market id here
    platform: POLY_US_PLATFORM,
    title: synthesizeTitle(market),
    slug,
    sport_tag: sportTagFor(market),
    // The book is quoted on outcome 0, exactly as polymarket.com does,
    // so the existing complement and outcome-index logic applies
    // unchanged.
    bid: bbo.bid,
    ask: bbo.ask,
    bid_size: bbo.bidDepth,
    ask_size: bbo.askDepth,
    yes_price: bbo.ask,
    no_price: bbo.ask == null ? null : Math.round((1 - bbo.ask) * 10000) / 10000,
    outcomes: outcomes ? JSON.stringify(outcomes) : null,
    outcome_prices: market.outcomePrices || null,
    fee_schedule: usFeeSchedule(market),
    side_label: null,
    event_ticker: null,
    close_time: market.endDate || null,
    // NULL, not 0. The gateway publishes no volume field on a market at
    // all - not an empty one, absent entirely - so 0 is a number we made
    // up. It read as "nobody has traded this", which is a claim about
    // the market rather than about our data, and the card then said so
    // in words.
    volume: null,
    updated_at: Math.floor(Date.now() / 1000),
  };
}


// A list-sourced US market (crypto, macro, finance, politics) in v1's
// row shape.
//
// Unlike games these ARE returned by /v1/markets, so they arrive in
// bulk with prices but no book — /bbo is a per-market call and there are
// hundreds. The book is left null here and filled by /api/refresh, which
// is already scoped to markets that appear in `pairs`, so only the
// handful that actually matched cost a request.
export function toMarketRow(market) {
  const tag = sportTagFor(market);
  if (!tag) return null; // culture, technology: nothing on Kalshi to pair

  const { yes, no } = sidePrices(market);
  return {
    id: String(market.slug || market.id),
    platform: POLY_US_PLATFORM,
    // Strike restored from the slug — see synthesizeTitle. Without it a
    // whole templated family shares one title and the scalar gates
    // cannot tell its members apart.
    title: synthesizeTitle(market),
    slug: market.slug || null,
    sport_tag: tag,
    yes_price: yes,
    no_price: no,
    bid: null,
    ask: null,
    fee_schedule: usFeeSchedule(market),
    outcomes: market.outcomes || null,
    outcome_prices: market.outcomePrices || null,
    // The market's own side label, and the thing that distinguishes it
    // from its siblings. Stored rather than discarded so the title is
    // not the only place it exists.
    side_label: String(market.titleShort || "").replace(/\s+/g, " ").trim() || null,
    event_ticker: null,
    close_time: market.endDate || null,
    // NULL, not 0. The gateway publishes no volume field on a market at
    // all - not an empty one, absent entirely - so 0 is a number we made
    // up. It read as "nobody has traded this", which is a claim about
    // the market rather than about our data, and the card then said so
    // in words.
    volume: null,
    updated_at: Math.floor(Date.now() / 1000),
  };
}
