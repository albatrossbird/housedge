// Bitcoin signals at an instant, for rule files that act on the
// underlying (lib/m15RuleBook.js): price, vwap_1h, change_5m, ema_12_1m,
// sma_20_1m, high_15m, low_15m, velocity_1m.
//
// NO LOOKAHEAD. A signal at time t is built only from what existed at t:
//   - `price` is the last BRTI tick at or before t, from the WebSocket
//     archive (k:"i5", timed by CF Benchmarks' own `x`). BRTI is the index
//     KXBTC15M settles on; a rule written against Coinbase's BTC-USD sees a
//     price a few dollars away, which matters only at the margins of a
//     `price > vwap_1h` comparison;
//   - the candle signals use COMPLETED one-minute Coinbase candles only:
//     the candle containing t has a close that has not happened yet, and
//     reading it is exactly the lookahead that flatters a backtest;
//   - change_5m and velocity_1m compare the price at t with the price
//     300s / 60s earlier, both from ticks at or before those moments.
// A tick or candle too old to describe t gives null, and a rule comparing
// a null matches nothing — a gap in the data never fires an order.
//
// Definitions (the rule files give names, not formulas):
//   vwap_1h      sum(typical x volume) / sum(volume) over the last 60
//                completed candles, typical = (high + low + close) / 3
//   ema_12_1m    EMA of completed closes, alpha = 2/13, seeded with the
//                SMA of the first 12
//   sma_20_1m    mean of the last 20 completed closes
//   high/low_15m extremes of the last 15 completed candles
//   change_5m    price_t / price_(t-300s) - 1, a fraction (0.001 = 0.1%)
//   velocity_1m  (price_t - price_(t-60s)) / 60, dollars a second; the
//                rules read only its sign, so the scale does not matter

const MIN = 60000;
const TICK_MAX_AGE_MS = 10000;     // a price this stale is not "now"
const CANDLE_MAX_AGE_MS = 3 * MIN; // nor is a candle set that stopped this long ago

// Last index i with xs[i] <= t, or -1.
function floorIdx(xs, t) {
  let lo = 0, hi = xs.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}

// Coinbase rows [time, low, high, open, close, volume] -> sorted, deduped candles.
export function toCandles(raw) {
  const by = new Map();
  for (const r of raw || []) {
    const [t, low, high, open, close, vol] = r.map(Number);
    if ([t, low, high, close, vol].every(Number.isFinite)) by.set(t, { start: t * 1000, low, high, open, close, vol });
  }
  return [...by.values()].sort((a, b) => a.start - b.start);
}

// A growing BRTI series, one value a second (the last in each second).
export function newTicks() { return { x: [], v: [] }; }
export function addTick(T, x, v) {
  if (!Number.isFinite(x) || !Number.isFinite(v) || v <= 0) return;
  const n = T.x.length;
  if (n && Math.floor(T.x[n - 1] / 1000) === Math.floor(x / 1000)) { if (x >= T.x[n - 1]) { T.x[n - 1] = x; T.v[n - 1] = v; } return; }
  if (n && x < T.x[n - 1]) return;     // out of order: the archive is time-ordered per file; drop rather than re-sort
  T.x.push(x); T.v.push(v);
}

export function makeSignals(candles, ticks) {
  const n = candles.length;
  const ends = candles.map(c => c.start + MIN);
  const starts = candles.map(c => c.start);
  // Prefix sums for the hour's VWAP; per-candle EMA and SMA.
  const pv = new Float64Array(n + 1), vv = new Float64Array(n + 1), cs = new Float64Array(n + 1);
  const ema = new Array(n).fill(null);
  const alpha = 2 / 13;
  for (let i = 0; i < n; i++) {
    const c = candles[i], typ = (c.high + c.low + c.close) / 3;
    pv[i + 1] = pv[i] + typ * c.vol; vv[i + 1] = vv[i] + c.vol; cs[i + 1] = cs[i] + c.close;
    if (i === 11) ema[i] = cs[12] / 12;
    else if (i > 11) ema[i] = alpha * c.close + (1 - alpha) * ema[i - 1];
  }
  const tickAt = t => {
    const i = floorIdx(ticks.x, t);
    return i >= 0 && t - ticks.x[i] <= TICK_MAX_AGE_MS ? ticks.v[i] : null;
  };

  return function at(t) {
    const out = { price: null, vwap_1h: null, change_5m: null, ema_12_1m: null, sma_20_1m: null, high_15m: null, low_15m: null, velocity_1m: null };
    const price = tickAt(t);
    out.price = price;
    if (price != null) {
      const p5 = tickAt(t - 5 * MIN), p1 = tickAt(t - MIN);
      if (p5 != null) out.change_5m = price / p5 - 1;
      if (p1 != null) out.velocity_1m = (price - p1) / 60;
    }
    const i = floorIdx(ends, t);                       // last candle that had CLOSED by t
    if (i < 0 || t - ends[i] > CANDLE_MAX_AGE_MS) return out;
    const from = (span) => { const j = floorIdx(starts, ends[i] - span - 1) + 1; return j; };   // first candle starting inside the span
    const h = from(60 * MIN);
    if (vv[i + 1] - vv[h] > 0) out.vwap_1h = (pv[i + 1] - pv[h]) / (vv[i + 1] - vv[h]);
    out.ema_12_1m = ema[i];
    if (i >= 19) out.sma_20_1m = (cs[i + 1] - cs[i - 19]) / 20;
    const q = from(15 * MIN);
    if (q <= i) {
      let hi = -Infinity, lo = Infinity;
      for (let k = q; k <= i; k++) { if (candles[k].high > hi) hi = candles[k].high; if (candles[k].low < lo) lo = candles[k].low; }
      out.high_15m = hi; out.low_15m = lo;
    }
    return out;
  };
}
