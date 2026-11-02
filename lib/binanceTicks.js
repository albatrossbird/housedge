// Binance's public BTCUSDT trade history as a stand-in for BRTI, for days
// the WebSocket archive never recorded (before 2026-09-30).
//
// data.binance.vision publishes every spot aggTrade as a daily zip, free
// and with no key (~12MB a day for BTCUSDT). A row is
//   aggTradeId, price, qty, firstTradeId, lastTradeId, time, isBuyerMaker, isBestMatch
// and `time` is in MICROseconds on files from 2025 on (milliseconds before),
// told apart by size.
//
// BRTI is a composite of USD venues Binance is not one of, and it is
// published five times a second. So the stand-in is the last Binance trade
// price sampled every 200ms: the same cadence the sharp-move decider sees
// from BRTI. A one-second move in basis points is what the rule reads, so
// the USDT/USD basis drops out; whether Binance moves WITH BRTI over one
// second is the question, and it is checked on October, where both exist,
// before any earlier day is read.

// One CSV line -> { t (ms), p } or null.
export function parseAggTrade(line) {
  const f = line.split(",");
  if (f.length < 6) return null;
  const p = Number(f[1]), raw = Number(f[5]);
  if (!(p > 0) || !Number.isFinite(raw)) return null;
  return { t: raw > 1e14 ? Math.floor(raw / 1000) : raw, p };
}

// Sample trades (time order) every `stepMs` across [fromMs, toMs]: each
// sample is the last trade at or before it. No trade yet: no sample.
export function sampleLast(trades, fromMs, toMs, stepMs = 200) {
  const out = [];
  let i = 0, last = null;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    while (i < trades.length && trades[i].t <= t) last = trades[i++];
    if (last) out.push({ t, v: last.p });
  }
  return out;
}
