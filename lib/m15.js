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

// Number(null) IS 0, AND 0 IS A CLAIM. Kalshi publishes no depth on the
// 15-minute family, so `yes_bid_size` arrives null — and a null coerced
// to zero reads as "nothing offered at the touch", which is a statement
// about the book rather than about what we know. Same trap that made
// complementBook quote a $1.00 offer that did not exist, and that made
// polymarket.us look like a market nobody had traded.
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
export function toM15Quote(m, now = Date.now()) {
  if (!m || !m.ticker || !m.close_time) return null;
  const close = Date.parse(m.close_time);
  return {
    ticker: m.ticker,
    observed_at: new Date(now).toISOString(),
    secs_to_close: Number.isFinite(close) ? Math.round((close - now) / 1000) : null,
    yes_bid: num(m.yes_bid_dollars),
    yes_ask: num(m.yes_ask_dollars),
    bid_size: num(m.yes_bid_size),
    ask_size: num(m.yes_ask_size),
    volume: num(m.volume_fp) ?? num(m.volume),
  };
}

// WRITE-ON-CHANGE. Polling 26 series every 15 seconds is ~150k rows a
// day, nearly all of them identical to the row before. Only the touch
// and the traded volume decide whether an observation is new; a
// heartbeat covers the case where nothing moves for a long time, so a
// flat market is distinguishable from a stopped recorder.
export function quoteChanged(prev, q, { heartbeatMs = 60000 } = {}) {
  if (!prev) return true;
  if (prev.yes_bid !== q.yes_bid || prev.yes_ask !== q.yes_ask) return true;
  if (prev.volume !== q.volume) return true;
  return Date.parse(q.observed_at) - Date.parse(prev.observed_at) >= heartbeatMs;
}
