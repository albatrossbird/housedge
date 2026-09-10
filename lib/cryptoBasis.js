// Does a free Coinbase feed agree with what Kalshi actually settled?
//
// WHY THIS QUESTION. KXBTC15M settles on "the simple average of the
// sixty seconds of CF Benchmarks' BRTI before <close>" against the same
// average before the open, fifteen minutes earlier. BRTI is a
// multi-exchange index — it is NOT Coinbase — and CF licenses it by
// contact with no public price and up to a 15 minute delay on the API.
//
// So the question is not "can we read BRTI" but "how wrong is a free
// proxy". That is measurable against 6,000+ settled markets we already
// hold, and the answer decides whether an institutional licence is
// needed at all.
//
// The pure half lives here so it can be tested. scripts/crypto-basis.mjs
// does the IO.

// Coinbase returns [ time, low, high, open, close, volume ] — LOW BEFORE
// HIGH and OPEN BEFORE CLOSE, which is not the order any other venue
// uses and silently inverts a result if read as OHLC. Named here once so
// no call site has to remember.
export function parseCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [time, low, high, open, close, volume] = row.map(Number);
  if (![time, low, high, open, close].every(Number.isFinite)) return null;
  return { time, low, high, open, close, volume };
}

// `time` is the START of the bucket, so the candle covering the sixty
// seconds ENDING at t is the one stamped t-60.
export function indexCandles(rows) {
  const m = new Map();
  for (const r of rows) {
    const c = parseCandle(r);
    if (c) m.set(c.time, c);
  }
  return m;
}

// The settlement reference for the sixty seconds ending at `t`.
//
// TWO READINGS, and we do not get to assume which is closer. Kalshi
// settles crypto on a sixty-second AVERAGE; a one-minute candle gives
// us its close (the last trade) or a typical price. Both are computed
// and reported so the data picks the winner rather than the author.
export function refPrice(index, tSecs, mode = "close") {
  const c = index.get(tSecs - 60);
  if (!c) return null;
  if (mode === "close") return c.close;
  if (mode === "typical") return (c.high + c.low + c.close) / 3;
  if (mode === "hl2") return (c.high + c.low) / 2;
  return null;
}

// Kalshi's rule is "at least", so a dead-heat resolves YES.
export function predict(openRef, closeRef) {
  if (openRef == null || closeRef == null) return null;
  return closeRef >= openRef ? "yes" : "no";
}

// Margin in basis points — how far the settlement was from a tie.
//
// AGGREGATE AGREEMENT IS THE WRONG NUMBER. A proxy for a multi-exchange
// index will only ever disagree near a tie, so a single percentage
// hides whether the disagreements are harmless (all inside a basis
// point) or disqualifying (spread across real moves). This repo has
// already been burned by an average that hid an 8-hour outage in one
// category; the same shape applies here.
export function marginBps(openRef, closeRef) {
  if (!openRef) return null;
  return ((closeRef - openRef) / openRef) * 10000;
}

const BANDS = [0.5, 1, 2, 5, 10, Infinity];

export function agreementByMargin(cases) {
  const rows = BANDS.map(hi => ({ hi, n: 0, agree: 0 }));
  let n = 0, agree = 0;
  for (const c of cases) {
    if (c.predicted == null || (c.actual !== "yes" && c.actual !== "no")) continue;
    const ok = c.predicted === c.actual;
    n++; if (ok) agree++;
    const a = Math.abs(c.bps);
    const row = rows.find(r => a < r.hi);
    if (row) { row.n++; if (ok) row.agree++; }
  }
  return { n, agree, rate: n ? agree / n : null, bands: rows.filter(r => r.n) };
}
