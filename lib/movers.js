// Movers and most-traded, across Kalshi, Polymarket US and polymarket.com.
//
// The home page's free "what is happening" section. Two lists:
//
//   moves   the biggest price changes over about a day, on markets with
//           real money behind them
//   traded  the most money traded over about a day
//
// One row per EVENT, not per market: Kalshi lists ~9 strikes per
// question, and "When will P vs NP be resolved?" moving filled five of
// the top eight rows on its own the first time this was tried.
//
// WHAT EACH VENUE PUBLISHES (checked 2026-11-26):
//   Kalshi          every market carries its bid/ask 24h ago
//                   (previous_yes_bid/ask_dollars) and 24h volume in
//                   contracts. One paced sweep of /events reads it all.
//   polymarket.com  oneDayPriceChange and volume24hr (dollars) on every
//                   market, events ordered by 24h volume server-side.
//   polymarket.us   NEITHER. The market list carries a current price and
//                   nothing about yesterday or volume. /bbo carries an
//                   all-time sharesTraded, so a day's volume is OUR
//                   snapshot subtracted from a later one, and a day's
//                   move is our own price from about a day ago. Kept in
//                   mover_history; for the first day after the job
//                   starts, .us rows have a price and nothing else.
//
// MONEY IS COMPARED IN DOLLARS. Kalshi and .us count contracts; .com
// counts dollars spent. A contract times its price is what the buyer of
// that side spent, which is how .com counts, so contracts x price is the
// comparable figure. It is an approximation (a NO buyer at 10c spent
// 10c, where this counts the YES price), stated on the page, and never
// summed across venues.

export const MOVER_CATEGORIES = ["sports", "politics", "economics", "crypto", "culture"];

export const DAY_MS = 24 * 3600 * 1000;
// A move under 3 points on a market is noise at these prices.
export const MIN_MOVE = 0.03;
// Money behind a market before its volume is worth a row, and before its
// MOVE is. At $1k the top moves were Bozeman housing permits and Stowe's
// opening day; at $5k they are Netanyahu, Bitcoin and Aaron Rodgers, with
// 7-22 rows still left per category (2026-11-26).
export const MIN_USD = 1000;
export const MOVE_MIN_USD = 5000;
// Rows kept per (venue, category, list). The page shows far fewer; the
// rest lets the API rank across venues without a second read.
export const KEEP_PER_LIST = 40;

const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A two-sided book's midpoint, or null. An untraded book reads 0/1 on
// both venues (see realBook in lib/fees.js) and is not a price.
export function mid(bid, ask) {
  const b = num(bid), a = num(ask);
  if (b == null || a == null || b <= 0 || a >= 1 || a < b) return null;
  return (b + a) / 2;
}

// The earlier of several times (ISO strings or epoch ms), as ISO.
export function earliest(...ts) {
  const ms = ts.map(t => (typeof t === "number" ? t : Date.parse(t))).filter(Number.isFinite);
  return ms.length ? new Date(Math.min(...ms)).toISOString() : null;
}

// ---------------------------------------------------------------- categories

export function kalshiCategory(cat) {
  const c = String(cat || "").toLowerCase();
  if (c === "sports") return "sports";
  if (c === "elections" || c === "politics" || c === "world") return "politics";
  if (c === "economics" || c === "financials" || c === "commodities") return "economics";
  if (c === "crypto") return "crypto";
  return "culture";
}

export function usCategory(cat) {
  const c = String(cat || "").toLowerCase();
  if (c === "sports") return "sports";
  if (c === "politics" || c === "geopolitics") return "politics";
  if (c === "macro" || c === "finance") return "economics";
  if (c === "crypto") return "crypto";
  return "culture";
}

// .com events carry tags, not a category. Checked in this order because
// an event is often tagged both "Crypto" and "Finance".
export function comCategory(tags) {
  const t = new Set((tags || []).map(x => String(x?.label || x?.slug || x || "").toLowerCase()));
  if (t.has("sports")) return "sports";
  if (t.has("crypto") || t.has("crypto prices")) return "crypto";
  if (t.has("politics") || t.has("elections") || t.has("geopolitics") || t.has("world")) return "politics";
  if (t.has("economy") || t.has("finance") || t.has("fed")) return "economics";
  return "culture";
}

// ---------------------------------------------------------------- Kalshi

// One Kalshi market as a candidate row, or null.
//
// The day-ago price is the day-ago MIDPOINT, not previous_price, which is
// the last TRADE a day ago: on a market that had not traded it reads 0,
// and the first cut of this list was all "0 -> 99" rows that were
// markets settling, not moving.
export function kalshiRow(m, ev, now = Date.now()) {
  if (!m?.ticker || m.ticker.startsWith("KXMVE")) return null;
  if (m.status && m.status !== "active") return null;
  const contracts = num(m.volume_24h_fp) ?? 0;
  const price = mid(m.yes_bid_dollars, m.yes_ask_dollars) ?? (num(m.last_price_dollars) > 0 ? num(m.last_price_dollars) : null);
  if (price == null) return null;
  const prev = mid(m.previous_yes_bid_dollars, m.previous_yes_ask_dollars);
  const opened = Date.parse(m.open_time);
  const single = (ev?.markets?.length ?? 1) <= 1;
  return {
    venue: "kalshi",
    market_id: m.ticker,
    event_id: m.event_ticker || ev?.event_ticker || m.ticker,
    title: String(ev?.title || m.title || m.ticker).replace(/\*\*/g, ""),
    outcome: single ? null : (m.yes_sub_title || null),
    category: kalshiCategory(ev?.category),
    price,
    // A market listed under a day ago has no "a day ago".
    prev: Number.isFinite(opened) && opened <= now - DAY_MS ? prev : null,
    volume_usd: contracts * (prev != null ? (price + prev) / 2 : price),
    // A game's close_time is weeks out; its EXPECTED expiration is the
    // night of the game, which is what "ends within a day" has to read.
    closes_at: earliest(m.close_time, m.expected_expiration_time),
    url: kalshiSearchUrl(ev?.title || m.title),
  };
}

// A real route, unlike the bare series path (see CLAUDE.md, Kalshi web
// URLs). The job swaps in the three-segment market URL where the series
// slug is stored.
export function kalshiSearchUrl(title) {
  return `https://kalshi.com/search?q=${encodeURIComponent(String(title || "").slice(0, 80))}`;
}

export function kalshiMarketUrl(ticker, eventTicker, seriesSlug) {
  const series = String(ticker || "").split("-")[0].toLowerCase();
  if (!series || !seriesSlug || !eventTicker) return null;
  return `https://kalshi.com/markets/${series}/${seriesSlug}/${String(eventTicker).toLowerCase()}`;
}

// One paced pass over every open Kalshi event, keeping only what the
// lists can use. MEASURED 2026-11-26: 104 pages, 20,732 events, 175,805
// markets in 41s at 300ms a page. Unpaced, the sixth page answered 429.
//
// Rows are reduced as each page arrives: the raw markets carry their
// rules text and would be ~350MB held at once, on a 1GB box.
export async function sweepKalshi({ keep = () => false, fetchImpl = fetch, now = Date.now(), pauseMs = 300, maxPages = 250 } = {}) {
  const rows = [];
  let cursor = null, pages = 0;
  while (pages < maxPages) {
    const u = new URL("https://api.elections.kalshi.com/trade-api/v2/events");
    u.searchParams.set("status", "open");
    u.searchParams.set("limit", "200");
    u.searchParams.set("with_nested_markets", "true");
    if (cursor) u.searchParams.set("cursor", cursor);
    const page = await getJson(u, fetchImpl);
    if (page.error) return { rows, pages, complete: false, failure: `kalshi page ${pages + 1}: ${page.error}` };
    pages++;
    for (const ev of page.body.events || []) {
      for (const m of ev.markets || []) {
        const r = kalshiRow(m, ev, now);
        if (r && ((num(m.volume_24h_fp) ?? 0) > 0 || keep(r.market_id))) rows.push(r);
      }
    }
    cursor = page.body.cursor;
    if (!cursor) return { rows, pages, complete: true, failure: null };
    if (pauseMs) await sleep(pauseMs);
  }
  return { rows, pages, complete: false, failure: `kalshi: page cap ${maxPages} reached with a cursor still open` };
}

// GET with retry on 429 and 5xx. A throttled page that gives up must
// never read as the end of the list.
export async function getJson(url, fetchImpl = fetch, { tries = 6, headers } = {}) {
  let failure = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const r = await fetchImpl(String(url), headers ? { headers } : undefined);
      if (r.ok) return { body: await r.json() };
      failure = `HTTP ${r.status}`;
      if (r.status === 404) return { error: failure, notFound: true };
      if (r.status !== 429 && r.status < 500) return { error: failure };
      const ra = Number(r.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 750 * 2 ** attempt);
    } catch (e) {
      failure = e?.cause?.code || e?.message || String(e);
      await sleep(750 * 2 ** attempt);
    }
  }
  return { error: failure };
}

// ---------------------------------------------------------------- polymarket.com

export function comRow(m, ev, now = Date.now()) {
  if (!m?.id || m.closed || m.active === false) return null;
  const price = num(m.lastTradePrice) ?? mid(m.bestBid, m.bestAsk);
  if (price == null || price <= 0 || price >= 1) return null;
  const change = num(m.oneDayPriceChange);
  const created = Date.parse(m.createdAt || m.startDate);
  const dayOld = Number.isFinite(created) && created <= now - DAY_MS;
  const prev = change != null && dayOld ? price - change : null;
  const multi = (ev?.markets?.filter(x => !x.closed).length ?? 1) > 1;
  let outcome = multi ? (m.groupItemTitle || m.question || null) : null;
  // A game's moneyline is priced on its FIRST outcome, which is a team,
  // not "Yes". Without the name the price belongs to nobody.
  if (!outcome) {
    try {
      const o = JSON.parse(m.outcomes || "[]");
      if (o[0] && o[0] !== "Yes") outcome = o[0];
    } catch { /* a bad outcomes string names nothing */ }
  }
  return {
    venue: "polymarket",
    market_id: String(m.id),
    event_id: ev?.slug || m.slug,
    title: ev?.title || m.question,
    outcome: outcome && outcome !== (ev?.title || m.question) ? outcome : null,
    category: comCategory(ev?.tags),
    price,
    prev: prev != null && prev > 0 && prev < 1 ? prev : null,
    volume_usd: num(m.volume24hr) ?? 0,
    // A game's endDate is days out; it is over a few hours after it starts.
    closes_at: earliest(m.endDate, m.gameStartTime && Date.parse(m.gameStartTime) + 4 * 3600e3),
    url: comEventUrl(ev?.slug || m.slug),
  };
}

const COM_GAME_SLUG = /^([a-z]{2,10})-[a-z0-9]{2,4}-[a-z0-9]{2,4}-\d{4}-\d{2}-\d{2}$/;
export function comEventUrl(slug) {
  const s = String(slug || "");
  if (!s) return "https://polymarket.com/";
  const g = s.match(COM_GAME_SLUG);
  return g ? `https://polymarket.com/sports/${g[1]}/${s}` : `https://polymarket.com/event/${s}`;
}

// Events ordered by 24h volume, server-side, so the walk stops at the
// first page whose events have all traded under the floor: everything
// after it has too.
export async function fetchCom({ fetchImpl = fetch, now = Date.now(), maxPages = 30, pageSize = 100 } = {}) {
  const rows = [];
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const u = `https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false&limit=${pageSize}&offset=${pages * pageSize}`;
    const page = await getJson(u, fetchImpl);
    if (page.error) return { rows, pages, complete: false, failure: `polymarket.com page ${pages + 1}: ${page.error}` };
    const events = Array.isArray(page.body) ? page.body : [];
    for (const ev of events) for (const m of ev.markets || []) {
      const r = comRow(m, ev, now);
      if (r) rows.push(r);
    }
    const tail = events[events.length - 1];
    if (events.length < pageSize || (num(tail?.volume24hr) ?? 0) < MIN_USD) {
      return { rows, pages: pages + 1, complete: true, failure: null };
    }
    await sleep(150);
  }
  return { rows, pages, complete: false, failure: `polymarket.com: page cap ${maxPages} reached` };
}

// Paired .com markets outside the top-volume events, by id. `limit` is
// sent explicitly: /markets defaults to 20 whatever number of ids is
// asked for (CLAUDE.md, Polymarket).
export async function fetchComByIds(ids, { fetchImpl = fetch, now = Date.now() } = {}) {
  const rows = [];
  const list = [...new Set(ids)].filter(id => /^\d+$/.test(id));
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const qs = chunk.map(id => `id=${id}`).join("&");
    const page = await getJson(`https://gamma-api.polymarket.com/markets?${qs}&limit=${chunk.length}`, fetchImpl);
    if (page.error || !Array.isArray(page.body)) continue;
    for (const m of page.body) {
      const ev = m.events?.[0] ? { ...m.events[0], markets: [m] } : null;
      const r = comRow(m, ev, now);
      if (r) rows.push(r);
    }
    await sleep(150);
  }
  return rows;
}

// ---------------------------------------------------------------- polymarket.us

// A .us market's current price, from the list (no extra call).
export function usListPrice(m) {
  return mid(m?.bestBidQuote?.value, m?.bestAskQuote?.value);
}

export function usRow(m, eventSlug = null) {
  const price = usListPrice(m);
  if (!m?.slug || price == null || m.closed) return null;
  const title = String(m.question || m.title || m.slug);
  // Every market in a templated family shares one question; the strike
  // or the name is in titleShort (CLAUDE.md, Polymarket US titles).
  const side = String(m.titleShort || m.title || "").trim();
  return {
    venue: "polymarket_us",
    market_id: m.slug,
    event_id: eventSlug || m.slug,
    title,
    outcome: side && side !== title && !/^yes$/i.test(side) ? side : null,
    category: usCategory(m.category),
    price,
    prev: null,
    volume_usd: null,
    closes_at: m.endDate || null,
    created_at: m.createdAt || null,
    url: usUrl(m.slug, eventSlug),
  };
}

export function usUrl(slug, eventSlug) {
  const s = String(slug || "");
  if (s.startsWith("aec-")) {
    const rest = s.slice(4);
    const league = rest.split("-")[0];
    return league && rest.includes("-")
      ? `https://polymarket.us/sports/${league}/${rest}?marketSlug=${encodeURIComponent(s)}`
      : "https://polymarket.us/";
  }
  if (!eventSlug) return `https://polymarket.us/event/${s}`;
  return eventSlug === s
    ? `https://polymarket.us/event/${eventSlug}`
    : `https://polymarket.us/event/${eventSlug}?marketSlug=${encodeURIComponent(s)}`;
}

// The .us books worth tracking: two-sided, inside 5 cents. On 2026-11-26
// that was 21,028 of 71,000 open markets; the rest have no one quoting
// them and would never make either list.
export function usTight(m) {
  const b = num(m?.bestBidQuote?.value), a = num(m?.bestAskQuote?.value);
  return b != null && a != null && b > 0 && a < 1 && a - b <= 0.05;
}

// .us MOVES come from our own hourly snapshot of every tracked book's
// price, taken from the list sweep (no per-market call): one row per
// hour, a map of slug -> price, ~1MB. The day-ago price is the snapshot
// nearest 24h ago inside 18-30h.
export const SNAPSHOT_EVERY_MS = 55 * 60 * 1000;
export function snapshotOf(pool) {
  const out = {};
  for (const r of pool) if (r.price != null) out[r.market_id] = Math.round(r.price * 1000) / 1000;
  return out;
}
export function dayAgoSnapshot(snaps, now = Date.now()) {
  let best = null, off = Infinity;
  for (const s of snaps || []) {
    const age = now - Date.parse(s.at);
    if (age < 18 * 3600e3 || age > 30 * 3600e3) continue;
    const o = Math.abs(age - DAY_MS);
    if (o < off) { off = o; best = s; }
  }
  return best;
}

// .us VOLUME needs /bbo, one market at a time, and the gateway allows
// about ONE READ A SECOND: measured 2026-11-26, 60 reads two at a time
// drew 48 HTTP 429s with Retry-After 8-10s. The price refresh on the
// same box reads /bbo for every paired .us leg, so this job reads a
// small, paced set and never competes with it for long.
export const US_BBO_BUDGET = 120;
export const US_BBO_PAUSE_MS = 1100;

// MEASURED 2026-11-26: 140 pages of 500, 227MB uncompressed, 54s.
export async function sweepUs({ fetchImpl = fetch, maxPages = 400, pageSize = 500, onMarket }) {
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const page = await getJson(`https://gateway.polymarket.us/v1/markets?limit=${pageSize}&offset=${pages * pageSize}&closed=false`, fetchImpl);
    if (page.error) return { pages, complete: false, failure: `polymarket.us page ${pages + 1}: ${page.error}` };
    const ms = page.body?.markets || [];
    for (const m of ms) onMarket(m);
    if (ms.length < pageSize) return { pages: pages + 1, complete: true, failure: null };
  }
  return { pages, complete: false, failure: `polymarket.us: page cap ${maxPages} reached` };
}

// One /bbo read, reduced to what the history keeps.
export async function usBbo(slug, fetchImpl = fetch) {
  const page = await getJson(`https://gateway.polymarket.us/v1/markets/${encodeURIComponent(slug)}/bbo`, fetchImpl, { tries: 4 });
  if (page.error) return { error: page.error, notFound: !!page.notFound };
  const d = page.body?.marketData || {};
  const px = v => num(v?.value);
  const shares = num(d.sharesTraded);
  const price = mid(px(d.bestBid), px(d.bestAsk)) ?? px(d.currentPx) ?? px(d.lastTradePx);
  return { shares, price };
}

// ---------------------------------------------------------------- .us history

// The history is a short list of [unixSeconds, price, sharesTraded],
// newest last, at most one entry per HISTORY_STEP and none older than
// HISTORY_KEEP. Small enough to rewrite whole on every visit.
export const HISTORY_STEP = 45 * 60;
export const HISTORY_KEEP = 30 * 3600;

export function appendHistory(hist, entry) {
  const out = (Array.isArray(hist) ? hist : []).filter(e => Array.isArray(e) && e[0] >= entry[0] - HISTORY_KEEP);
  const last = out[out.length - 1];
  if (last && entry[0] - last[0] < HISTORY_STEP) out[out.length - 1] = entry;
  else out.push(entry);
  return out;
}

// The day-ago entry, and what has happened since. The base is the entry
// nearest to 24h ago inside 18-30h; outside that window there is no
// honest day-ago figure and the row says nothing. Volume is scaled to a
// day from whatever the gap actually was.
export function fromHistory(hist, nowSec) {
  const h = Array.isArray(hist) ? hist : [];
  const latest = h[h.length - 1];
  if (!latest) return { prev: null, volumeShares: null };
  let base = null, best = Infinity;
  for (const e of h) {
    const age = nowSec - e[0];
    if (age < 18 * 3600 || age > 30 * 3600) continue;
    const off = Math.abs(age - 24 * 3600);
    if (off < best) { best = off; base = e; }
  }
  if (!base) return { prev: null, volumeShares: null, latest };
  const span = latest[0] - base[0];
  const dShares = latest[2] != null && base[2] != null && span > 0 ? Math.max(0, latest[2] - base[2]) * (24 * 3600 / span) : null;
  return { prev: base[1] ?? null, volumeShares: dShares, latest };
}

// Which .us books to read this run: every paired one and every one that
// ranked last time, then a rotating slice of the rest so each tight
// book is visited every few hours.
export function usVisitPlan(pool, { priority = [], budget = 1500, runIndex = 0 }) {
  const chosen = new Set(priority.filter(s => pool.has(s)));
  const rest = [...pool].filter(s => !chosen.has(s)).sort();
  const room = Math.max(0, budget - chosen.size);
  if (rest.length && room) {
    const start = (runIndex * room) % rest.length;
    for (let i = 0; i < Math.min(room, rest.length); i++) chosen.add(rest[(start + i) % rest.length]);
  }
  return [...chosen];
}

// ---------------------------------------------------------------- ranking

// The two lists for one venue, one row per event, KEEP_PER_LIST per
// category. Markets closing inside a day are left out of MOVES: a game
// in progress or a number released this morning swings 50 points, and a
// list of those is a list of things ending, not of opinion changing.
// They stay in TRADED, where they are the truth.
export function rankVenue(rows, now = Date.now()) {
  const moves = [], traded = [];
  const best = (list, score) => {
    const byEvent = new Map();
    for (const r of list) {
      const s = score(r);
      const cur = byEvent.get(r.event_id);
      if (!cur || s > cur.s) byEvent.set(r.event_id, { r, s });
    }
    const byCat = new Map();
    for (const { r, s } of byEvent.values()) {
      if (!byCat.has(r.category)) byCat.set(r.category, []);
      byCat.get(r.category).push({ r, s });
    }
    const out = [];
    for (const xs of byCat.values()) out.push(...xs.sort((a, b) => b.s - a.s).slice(0, KEEP_PER_LIST).map(x => x.r));
    return out;
  };
  const enough = r => (r.volume_usd ?? 0) >= MIN_USD;
  const lasts = r => { const t = Date.parse(r.closes_at); return !Number.isFinite(t) || t > now + DAY_MS; };
  // A price at 0-3c or 97-100c is a question mostly ANSWERED: the first
  // cut's top moves were finished games and released numbers going to
  // 1c or 99c. Traded keeps them down to 1c/99c, where a finished
  // market's clean-up trading would otherwise lead the list.
  const open = (r, edge) => r.price > edge && r.price < 1 - edge;
  moves.push(...best(rows.filter(r => r.prev != null && (r.volume_usd ?? 0) >= MOVE_MIN_USD && lasts(r) && open(r, 0.03) && Math.abs(r.price - r.prev) >= MIN_MOVE),
    r => Math.abs(r.price - r.prev)));
  traded.push(...best(rows.filter(r => enough(r) && open(r, 0.01)), r => r.volume_usd));
  return { moves, traded };
}

// The same claim on the other venues, from pairs. A Kalshi id maps to
// its Polymarket ids; a Polymarket id maps back through its Kalshi id.
export function counterpartIds(venue, id, pairs) {
  if (venue === "kalshi") return [...(pairs.byKalshi.get(id) || [])].map(p => ({ id: p, venue: /^\d+$/.test(p) ? "polymarket" : "polymarket_us" }));
  const k = pairs.byPoly.get(id);
  if (!k) return [];
  return [{ id: k, venue: "kalshi" }, ...[...(pairs.byKalshi.get(k) || [])].filter(p => p !== id)
    .map(p => ({ id: p, venue: /^\d+$/.test(p) ? "polymarket" : "polymarket_us" }))];
}

export function indexPairs(rows) {
  const byKalshi = new Map(), byPoly = new Map();
  for (const p of rows || []) {
    if (!p?.kalshi_id || !p?.polymarket_id) continue;
    if (!byKalshi.has(p.kalshi_id)) byKalshi.set(p.kalshi_id, new Set());
    byKalshi.get(p.kalshi_id).add(String(p.polymarket_id));
    byPoly.set(String(p.polymarket_id), p.kalshi_id);
  }
  return { byKalshi, byPoly };
}

// The row as stored: the list it is on, rounded figures, and the other
// venues' price and move for the same claim.
const iso = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function storedRow(r, list, also, runAt) {
  const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  return {
    venue: r.venue, market_id: r.market_id, list,
    event_id: String(r.event_id).slice(0, 200),
    title: String(r.title || "").slice(0, 300),
    outcome: r.outcome ? String(r.outcome).slice(0, 200) : null,
    category: r.category,
    price: round(r.price, 4),
    prev: round(r.prev, 4),
    volume_usd: r.volume_usd == null ? null : Math.round(r.volume_usd),
    closes_at: iso(r.closes_at),
    url: r.url,
    also: (also || []).map(a => ({ venue: a.venue, market_id: a.market_id, price: round(a.price, 4), prev: round(a.prev, 4), url: a.url })),
    updated_at: runAt,
  };
}

// ---------------------------------------------------------------- the API's view

export const VENUE_ORDER = ["kalshi", "polymarket_us", "polymarket"];
const SHOW = 12;

// Stored rows -> what the page shows: per list, per category (and
// "all"), the top rows ACROSS venues, with one row per claim. A Kalshi
// market and its Polymarket US twin both moving is one story, so the
// stronger of the two leads and the other rides in `also`.
export function shapeMovers(rows, now = Date.now()) {
  const out = { moves: {}, traded: {}, venues: {}, counts: {} };
  for (const v of VENUE_ORDER) {
    const mine = rows.filter(r => r.venue === v);
    const at = Math.max(0, ...mine.map(r => Date.parse(r.updated_at) || 0));
    out.venues[v] = {
      rows: mine.length,
      ageSeconds: at ? Math.max(0, Math.round((now - at) / 1000)) : null,
      withDayAgo: mine.filter(r => r.prev != null).length,
    };
  }
  const score = { moves: r => Math.abs(r.price - r.prev), traded: r => r.volume_usd || 0 };
  for (const list of ["moves", "traded"]) {
    const xs = rows.filter(r => r.list === list && r.price != null && (list === "traded" || r.prev != null));
    for (const cat of ["all", ...MOVER_CATEGORIES]) {
      const pool = xs.filter(r => cat === "all" || r.category === cat).sort((a, b) => score[list](b) - score[list](a));
      const seen = new Set();
      const picked = [];
      for (const r of pool) {
        const keys = [`${r.venue}:${r.market_id}`, ...(r.also || []).map(a => `${a.venue}:${a.market_id}`)];
        if (keys.some(k => seen.has(k))) continue;
        keys.forEach(k => seen.add(k));
        picked.push(viewRow(r));
        if (picked.length >= SHOW) break;
      }
      out[list][cat] = picked;
      if (list === "traded") out.counts[cat] = pool.length;
    }
  }
  return out;
}

function viewRow(r) {
  const ch = (p, q) => (p == null || q == null ? null : Math.round((p - q) * 1000) / 1000);
  return {
    venue: r.venue, title: r.title, outcome: r.outcome, category: r.category,
    price: r.price, prev: r.prev, change: ch(r.price, r.prev),
    volumeUsd: r.volume_usd, closesAt: r.closes_at, url: r.url,
    also: (r.also || []).filter(a => a.price != null).map(a => ({ venue: a.venue, price: a.price, change: ch(a.price, a.prev), url: a.url })),
  };
}
