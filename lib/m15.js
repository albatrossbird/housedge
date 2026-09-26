// Kalshi's 15-minute markets.
//
// A separate family from everything else this project touches: one open
// market per series at a time, alive for fifteen minutes, settling on a
// sixty-second average of an index. Enumerated by SUFFIX rather than by
// a hand-written list, because the list moves — Kalshi has added coins
// to it steadily — and a constant here would go stale the same way
// KALSHI_SERIES did for crypto and politics.
export const M15_SUFFIX = /15M$/;

// The categories that carry them, so the sweep is three calls rather
// than fourteen. Verified 2026-09-06: Crypto 13, Commodities 6,
// Financials 5, Economics 0 — 24 of the 26 known series. `Economics` is
// swept anyway because it costs one call and the family is growing.
export const M15_CATEGORIES = ["Crypto", "Commodities", "Financials", "Economics"];

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

// A rate limiter does not relent in 400ms — the lesson /api/refresh
// learned when widening its poll list drew sixteen straight 429s. This
// recorder polls far harder than that job does, so it honours
// Retry-After and backs off rather than adding requests to a throttle.
export async function kalshiGet(path, { attempts = 4, fetchImpl = fetch } = {}) {
  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    let waitMs = 500 * Math.pow(2, i);
    try {
      const r = await fetchImpl(`${BASE}${path}`);
      if (r.ok) return { ok: true, body: await r.json() };
      if (r.status !== 429 && r.status < 500) return { ok: false, status: r.status };
      if (last) return { ok: false, status: r.status };
      if (r.status === 429) {
        const ra = Number(r.headers.get("retry-after"));
        waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * Math.pow(2, i);
      }
    } catch (err) {
      if (last) return { ok: false, error: err.message };
    }
    await new Promise(res => setTimeout(res, waitMs));
  }
  return { ok: false, error: "exhausted retries" };
}

// Every 15-minute series the exchange currently lists.
export async function listM15Series(opts = {}) {
  const found = new Map();
  const errors = [];
  for (const cat of M15_CATEGORIES) {
    const r = await kalshiGet(`/series?category=${encodeURIComponent(cat)}`, opts);
    if (!r.ok) { errors.push(`${cat}: ${r.status || r.error}`); continue; }
    for (const s of (r.body.series || [])) {
      if (s.ticker && M15_SUFFIX.test(s.ticker)) found.set(s.ticker, { ticker: s.ticker, title: s.title, category: cat });
    }
  }
  return { series: [...found.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)), errors };
}

// Number(null) IS 0, AND 0 IS A CLAIM. A size we did not receive is null,
// and a null coerced to zero reads as "nothing offered at the touch",
// which is a statement about the book rather than about what we know.
// Same trap that made complementBook quote a $1.00 offer that did not
// exist, and that made polymarket.us look like a market nobody had
// traded.
//
// A zero the VENUE sends is different and is kept: `yes_ask_size_fp:
// "0.00"` beside an ask of 1.00 is Kalshi saying nothing is offered, and
// that is a fact about the book.
const num = v => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The row shape both the live poll and the settled backfill write, so a
// market that was watched live and one that was only ever seen settled
// are the same record rather than two half-populated ones.
export function toM15Row(m, series) {
  if (!m || !m.ticker) return null;
  return {
    ticker: m.ticker,
    series: series || String(m.ticker).split("-")[0],
    event_ticker: m.event_ticker || null,
    title: m.title || null,
    // Kalshi states the reference as floor_strike on these; cap_strike
    // is null for the up/down shape and set for ranged ones.
    strike: num(m.floor_strike) ?? num(m.cap_strike),
    open_time: m.open_time || null,
    close_time: m.close_time || null,
    // Absent while live. Empty string is Kalshi's "not settled", which
    // must not become the string "" in a column that means an outcome.
    result: m.result === "yes" || m.result === "no" ? m.result : null,
    last_price: num(m.last_price_dollars) ?? (num(m.last_price) != null ? num(m.last_price) / 100 : null),
    volume: num(m.volume_fp) ?? num(m.volume),
    open_interest: num(m.open_interest_fp) ?? num(m.open_interest),
    updated_at: new Date().toISOString(),
  };
}

// One observation of a live book. `secs_to_close` is stored rather than
// derived because every question about a 15-minute market is "how late
// was this", and computing it per row over millions is the slow way.
// `source` names the recorder, and is OMITTED rather than nulled when
// not supplied. A row carrying `source: null` and a row with no such key
// are different things to PostgREST: a bulk insert rejects objects whose
// key sets differ, and a database without migration 0023 rejects the
// column outright. Omitting keeps both cases working.
export function toM15Quote(m, now = Date.now(), source = null) {
  if (!m || !m.ticker || !m.close_time) return null;
  const close = Date.parse(m.close_time);
  return {
    ticker: m.ticker,
    ...(source ? { source } : {}),
    observed_at: new Date(now).toISOString(),
    secs_to_close: Number.isFinite(close) ? Math.round((close - now) / 1000) : null,
    yes_bid: num(m.yes_bid_dollars),
    yes_ask: num(m.yes_ask_dollars),
    // THE KEY IS `_fp`. This read `yes_bid_size` for weeks — a key Kalshi
    // does not send — so every row stored null and the null was written
    // up as "Kalshi publishes no size on this family", which spread into
    // four scripts' caveats and live copy on /fees. The feed carried the
    // touch size all along (`yes_bid_size_fp: "394402.33"` on a live
    // KXBTC15M market, 2026-09-26). The test fixture had been hand-built
    // with `yes_bid_size: null`, shaped to match the code rather than
    // captured from the API, so the test pinned the bug in place.
    // The unsuffixed key is still read as a fallback, never preferred.
    bid_size: num(m.yes_bid_size_fp) ?? num(m.yes_bid_size),
    ask_size: num(m.yes_ask_size_fp) ?? num(m.yes_ask_size),
    volume: num(m.volume_fp) ?? num(m.volume),
  };
}

// WRITE-ON-CHANGE. Polling 26 series every 15 seconds is ~150k rows a
// day, nearly all of them identical to the row before. Only the touch
// and the traded volume decide whether an observation is new; a
// heartbeat covers the case where nothing moves for a long time, so a
// flat market is distinguishable from a stopped recorder.
// The market row is UPSERTED, and upserting it every tick is the most
// expensive thing this recorder does.
//
// MEASURED, from this project's own first live run: 380 market writes
// against 142 quote writes in four minutes — 2.7x the quotes, and of a
// worse kind. A quote is an APPEND to a growing table. A market row is
// an UPDATE of one of ~26 hot rows, and Postgres implements that as a
// new tuple plus an entry in every index plus a dead tuple for
// autovacuum to collect. At a 15s cadence that is roughly 140,000
// rewrites a day of the same two dozen rows.
//
// That is what exhausts a disk IO budget, and it is the same discipline
// `quoteChanged` already applies one line below, never extended here.
//
// WHAT ACTUALLY NEEDS WRITING PROMPTLY is narrow. This row exists so a
// window we watched live is present before the backfill sees it settle,
// so: the row being NEW matters, and `result` arriving matters. The
// price and volume fields move constantly and are re-read wholesale by
// backfill-15m.yml every day, so paying per-tick IO for them buys a
// freshness nobody reads.
//
// The heartbeat is long for the same reason — a fifteen-minute window
// only needs its row to exist once.
export function marketChanged(prev, row, { heartbeatMs = 300000 } = {}) {
  if (!prev) return true;
  // The settlement, which is the whole point of the row.
  if (prev.result !== row.result) return true;
  // Identity and terms. These do not drift, so a change is real.
  if (prev.close_time !== row.close_time) return true;
  if (prev.strike !== row.strike) return true;
  if (prev.title !== row.title) return true;
  return Date.parse(row.updated_at) - Date.parse(prev.updated_at) >= heartbeatMs;
}

// The BOOK's touch counts as a change too. The list's yes_bid/yes_ask
// come through a 15-second CDN cache, so on their own they decide when to
// sample the market at moments the cache chooses; book_bid/book_ask are
// the live touch. DEPTH does not count — sizes churn every tick, and
// letting them trigger writes would multiply the append rate for a
// quantity that rides along on the rows prices already produce.
export function quoteChanged(prev, q, { heartbeatMs = 60000 } = {}) {
  if (!prev) return true;
  if (prev.yes_bid !== q.yes_bid || prev.yes_ask !== q.yes_ask) return true;
  if (prev.book_bid !== q.book_bid || prev.book_ask !== q.book_ask) return true;
  if (prev.volume !== q.volume) return true;
  return Date.parse(q.observed_at) - Date.parse(prev.observed_at) >= heartbeatMs;
}

// DEPTH BEYOND THE TOUCH, from `/markets/<ticker>/orderbook`.
//
// The touch size rides on the /markets row; this is everything behind it,
// summed within 1, 3 and 5 cents of the best price. That is enough to
// price a realistic order and to test book-imbalance signals, without
// storing ~270 levels per row on a table that takes ~50k appends a day.
//
// KALSHI PUBLISHES TWO BID STACKS, NOT A BID AND AN ASK. `yes_dollars` is
// resting YES bids and `no_dollars` is resting NO bids. A NO bid at p is a
// YES offer at 1 - p, so the YES ask side IS the NO bid stack, mirrored.
// Reading `no_dollars` as asks directly would put the offers at the wrong
// end of the probability range.
//
// Levels are compared in TENTHS OF A CENT, as integers. Prices arrive as
// four-decimal strings and some markets tick below a cent, so float
// arithmetic on "0.3800" - "0.3700" is exactly the comparison that goes
// wrong at a window's edge.
//
// Order is not trusted. The live book arrives sorted ascending with the
// best level LAST, which is the opposite of what reading [0] assumes, so
// the best is found by value rather than by position.
//
// AN EMPTY SIDE IS ZERO, AN ABSENT BOOK IS NULL. If the book was fetched
// and nobody is bidding, depth 0 is a true statement about the market. If
// the fetch failed there is no statement to make, and every field is null
// — the same null-is-not-zero rule as the touch size above.
export const DEPTH_WINDOWS_CENTS = [1, 3, 5];

export function bookDepth(resp, windows = DEPTH_WINDOWS_CENTS) {
  const empty = { book_bid: null, book_ask: null };
  for (const w of windows) { empty[`bid_depth_${w}c`] = null; empty[`ask_depth_${w}c`] = null; }
  const ob = resp?.orderbook_fp || resp?.orderbook;
  if (!ob || typeof ob !== "object") return empty;

  const levels = side => (Array.isArray(ob[side]) ? ob[side] : [])
    .map(([p, sz]) => [Math.round(Number(p) * 1000), Number(sz)])
    .filter(([p, sz]) => Number.isFinite(p) && Number.isFinite(sz) && sz > 0);

  const yes = levels("yes_dollars");            // YES bids
  const no  = levels("no_dollars");             // NO bids == YES offers at 1 - p

  const bestYes = yes.length ? Math.max(...yes.map(l => l[0])) : null;
  const bestNo  = no.length  ? Math.max(...no.map(l => l[0]))  : null;

  const out = {
    book_bid: bestYes == null ? null : bestYes / 1000,
    book_ask: bestNo  == null ? null : (1000 - bestNo) / 1000,
  };
  const within = (lv, best, w) => best == null ? 0
    : lv.reduce((a, [p, sz]) => a + (best - p <= w * 10 ? sz : 0), 0);
  const r2 = x => Math.round(x * 100) / 100;
  for (const w of windows) {
    out[`bid_depth_${w}c`] = r2(within(yes, bestYes, w));
    out[`ask_depth_${w}c`] = r2(within(no, bestNo, w));
  }
  return out;
}
