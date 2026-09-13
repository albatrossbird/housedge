// Kairos Market Data API — free, anonymous, read-only.
//
// https://md.kairos.trade, OpenAPI 3.1, x-kairos-anonymous: true.
// Verified by running their own documented example with no credentials.
//
// WHY IT MATTERS HERE. It serves 1-MINUTE KALSHI CANDLES WITH 30-DAY
// RETENTION. This project has been treating the intra-window price path
// as unrecoverable and waiting for its own recorder to accumulate; this
// is six times that history, available immediately.
//
// AND WHY IT IS NOT A SUBSTITUTE. A candle is TRADED prices — open,
// high, low, close — and our calibration asks what a BUYER would have
// paid, which is the ask. On a liquid market those are close; near a
// tie they are exactly where they diverge, and near a tie is where the
// money is. So candle data widens the sample, and the disagreement
// between it and the recorded book is itself a thing to measure rather
// than assume away.
//
// Nothing from here is written into m15_quotes. That table is a record
// of the BOOK, and mixing traded prices into it would destroy the
// distinction that makes it worth having.
//
// RATE LIMITS, read from the spec rather than guessed. Anonymous is
// 120 light units/min and 20 heavy/min, per source IP. Candles are
// LIGHT and cost "1 unit + 1 per 5000 requested bars", and the batch
// endpoint takes 200 series for 1 unit admitted up front. A 15-minute
// market is 15 one-minute bars, so 200 of them is 3,000 bars — one
// unit. That is ~24,000 markets a minute anonymously, which makes this
// effectively free for our volumes.
//
// TERMS ARE UNREAD, AND THAT IS A CONSTRAINT. The spec declares
// termsOfService: https://kairos.trade/terms and that URL 404s, so the
// redistribution and commercial-use rules cannot be checked. Fine for
// internal measurement, which is plainly what an anonymous documented
// endpoint invites. NOT fine for republishing their data or building a
// public feature on it until the terms can actually be read.

const BASE = "https://md.kairos.trade";
export const CANDLE_BATCH = 200;

const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");

// 429 carries Retry-After. Kalshi taught this project that three
// retries 400ms apart is not a retry against a throttle — it is three
// more requests into it.
export async function kairos(path, { body = null, attempts = 4, fetchImpl = fetch } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchImpl(`${BASE}${path}`, {
        method: body ? "POST" : "GET",
        headers: { "User-Agent": "marketslap-research/1.0", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (r.status === 429) {
        const wait = Number(r.headers.get("retry-after")) * 1000 || 2000 * (i + 1);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) throw new Error(`kairos ${r.status} ${path.slice(0, 50)} ${(await r.text()).slice(0, 140)}`);
      const json = await r.json();
      return {
        json,
        remaining: num(r.headers.get("x-ratelimit-remaining")),
        bucket: r.headers.get("x-ratelimit-bucket"),
      };
    } catch (err) { last = err; await new Promise(res => setTimeout(res, 700 * (i + 1))); }
  }
  throw last || new Error(`kairos failed ${path.slice(0, 50)}`);
}

// Up to 200 candle series in one request, with PER-INDEX partial
// failure — one item's error does not fail the others, so a result
// must be matched back by index and its own `error` field checked.
// Treating a failed item as an empty series would silently shrink the
// sample, which is the defect this repo keeps finding.
export async function candleBatch(items, opts = {}) {
  if (!items.length) return { series: [], failures: [], remaining: null };
  const { json, remaining } = await kairos("/v1/candles/batch", {
    body: { requests: items.map(i => ({
      provider: i.provider || "kalshi",
      contract_id: i.ticker,
      timeframe_seconds: i.timeframe ?? 60,
      start: iso(i.start),
      end: iso(i.end),
    })) },
    ...opts,
  });
  const results = json?.results || [];
  const series = [], failures = [];
  for (const r of results) {
    const src = items[r.index];
    if (!src) continue;
    if (r.error) { failures.push({ ticker: src.ticker, error: String(r.error).slice(0, 120) }); continue; }
    series.push({ ticker: src.ticker, candles: r.candles || [] });
  }
  return { series, failures, remaining };
}

// Kalshi candle prices come back in CENTS (49, 99.9), while every
// stored price in this project is a dollar fraction. Reading one as
// the other is a 100x error that still looks like a plausible price,
// which is the dangerous kind.
export const centsToPrice = v => {
  const n = num(v);
  return n == null ? null : n / 100;
};

// The candle CONTAINING the instant t.
//
// Candle buckets sit on minute boundaries; the instants we care about
// do not. A 15-minute market closing at 14:45:00 is 90 seconds from
// close at 14:43:30, which is stamped by no bucket at all — the
// covering bucket is 14:43:00. Matching on an exact stamp therefore
// found NOTHING across 303 live markets while every other counter read
// healthy, which is the shape of failure this project keeps meeting: a
// zero that looks like absence and is really a mismatch.
//
// So the instant is floored to its bucket rather than compared to one.
export function candleCovering(candles, tSecs) {
  if (!Number.isFinite(tSecs)) return null;
  const want = Math.floor(tSecs / 60) * 60 * 1000;
  for (const c of candles || []) {
    const b = Date.parse(c.bucket_start);
    if (Number.isFinite(b) && b === want) return c;
  }
  return null;
}
