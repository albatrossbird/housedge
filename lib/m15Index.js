// KXBTC15M against the index it settles on (scripts/m15-index.mjs reads
// the archive; this file holds the arithmetic).
//
// Kalshi settles each window on the simple average of the 60 BRTI prices
// in the minute before the close, and its strike is the same average for
// the minute before the open. The archive records BRTI at 5Hz, so a
// second's price here is the last tick at or before the end of that
// second. Whether that reconstruction matches Kalshi's is MEASURED, not
// assumed: the script reports how often the reconstructed close lands on
// the side Kalshi settled, and how far the reconstructed open sits from
// Kalshi's stated strike.

import { atOrBefore } from "./brtiLag.js";

export const STALE_MS = 2000;

// The 60 per-second prices for the minute ending at endMs: one per second,
// each the last tick at or before (second end - 1ms). Null if any second
// has no tick within STALE_MS before it — a silence is not a price.
export function secondPrices(ticks, endMs, { from = 0, staleMs = STALE_MS } = {}) {
  const out = [];
  for (let k = from + 1; k <= 60; k++) {
    const at = endMs - 60000 + k * 1000 - 1;
    const r = atOrBefore(ticks, at);
    if (!r || at - r.t > staleMs) return null;
    out.push(r.v);
  }
  return out;
}

export function settleAvg(ticks, endMs, opts) {
  const p = secondPrices(ticks, endMs, opts);
  return p ? p.reduce((s, v) => s + v, 0) / 60 : null;
}

// The settlement average as it can be estimated `secsLeft` seconds before
// the close: the seconds already in the averaging minute are known, and
// every second still to come is taken at the latest price. Null outside
// the averaging minute or when the record has a hole.
export function estimateAvg(ticks, closeMs, secsLeft, { staleMs = STALE_MS } = {}) {
  if (!(secsLeft > 0 && secsLeft <= 60)) return null;
  const now = closeMs - secsLeft * 1000;
  const spot = atOrBefore(ticks, now);
  if (!spot || now - spot.t > staleMs) return null;
  const known = 60 - secsLeft;
  let sum = 0;
  for (let k = 1; k <= known; k++) {
    const at = closeMs - 60000 + k * 1000 - 1;
    const r = atOrBefore(ticks, at);
    if (!r || at - r.t > staleMs) return null;
    sum += r.v;
  }
  return { est: (sum + spot.v * secsLeft) / 60, spot: spot.v, known };
}

// Which bucket a value falls in: edges ascending, last bucket open-ended.
export function bucketOf(x, edges) {
  for (let i = 0; i < edges.length - 1; i++) if (x >= edges[i] && x < edges[i + 1]) return i;
  return x >= edges[edges.length - 1] ? edges.length - 1 : -1;
}
export const bucketLabel = (edges, i, unit = "$") =>
  i < edges.length - 1 ? `${unit}${edges[i]}-${edges[i + 1]}` : `${unit}${edges[i]}+`;

// The price to BUY a side off a once-a-second book row.
export const buyPrice = (row, side) => (side === "yes" ? row.ask : Math.round((1 - row.bid) * 10000) / 10000);

// P&L across days: total, per contract, t of the daily mean over its
// standard error, and the earlier and later halves of the days apart.
// trades: [{ day: "YYYY-MM-DD", pnl, ctrs }].
export function dayStats(trades) {
  const byDay = new Map();
  for (const x of trades) byDay.set(x.day, (byDay.get(x.day) || 0) + x.pnl);
  const days = [...byDay.keys()].sort(), v = days.map(d => byDay.get(d)), n = v.length;
  const pnl = trades.reduce((s, x) => s + x.pnl, 0), ctrs = trades.reduce((s, x) => s + x.ctrs, 0);
  const mean = n ? pnl / n : 0, sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const half = Math.floor(n / 2), sum = a => a.reduce((s, x) => s + x, 0);
  const halfCtr = ds => { const set = new Set(ds); const c = trades.filter(x => set.has(x.day)).reduce((s, x) => s + x.ctrs, 0); return c ? sum(ds.map(d => byDay.get(d))) / c : null; };
  return { n: trades.length, ctrs, pnl, perCtr: ctrs ? pnl / ctrs : null, days: n, t: sd > 1e-12 ? mean / (sd / Math.sqrt(n)) : null,
    earlyPerCtr: halfCtr(days.slice(0, half)), latePerCtr: halfCtr(days.slice(half)) };
}
