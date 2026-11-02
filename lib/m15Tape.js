// Backtesting a 15-minute rule on Kalshi's TRADE TAPE instead of a
// recorded book (scripts/m15-tape-backtest.mjs reads it).
//
// Kalshi publishes every trade on every market, free and with no key:
// /markets/trades for markets settled after the cutoff GET
// /historical/cutoff reports, /historical/trades before it (checked
// 2026-11-02: a KXBTC15M window from 2026-07-01 answers). It publishes no
// order-book history. So a rule like p75 ("buy the favourite at 75-97c,
// 15-45s before the close") is decided here on the first trade in which a
// taker BOUGHT a side at a price in the band: that price was on offer at
// that moment, because somebody paid it.
//
// What this cannot see, so read every result as an upper bound beside
// the archive backtest, which can:
//   - the spread (no book), so a rule's spread cap is not applied;
//   - windows where the side was on offer but nobody bought it: they are
//     not decided at all, which tilts the sample toward busy windows;
//   - our own fill: we are assumed to get `size` at the printed price.
//     The print's own size is kept, so "at least `size` printed" can be
//     read separately.

// One Kalshi trade -> { t (ms), side, price (of the side bought), count }.
// taker_side is the side the taker bought; its price is that side's.
export function parseTrade(raw) {
  const t = Date.parse(raw.created_time), side = raw.taker_side;
  if (!Number.isFinite(t) || (side !== "yes" && side !== "no")) return null;
  const price = Number(side === "yes" ? raw.yes_price_dollars : raw.no_price_dollars);
  const count = Number(raw.count_fp ?? raw.count);
  if (!(price > 0 && price < 1) || !(count > 0)) return null;
  return { t, side, price, count };
}

// The rule's decision on a window's trades: the EARLIEST taker buy inside
// [close - secsMax, close - secsMin] at a price in [priceMin, priceMax].
// A side bought at 75c or more is the favourite by construction, so
// "favourite" needs no book. Null when no trade qualifies.
export function tapeEntry(trades, close, { secsMin = 15, secsMax = 45, priceMin = 0.75, priceMax = 0.97 } = {}) {
  let best = null;
  for (const x of trades) {
    if (!x) continue;
    const secs = (close - x.t) / 1000;
    if (secs < secsMin || secs > secsMax) continue;
    if (x.price < priceMin - 1e-9 || x.price > priceMax + 1e-9) continue;
    if (!best || x.t < best.t) best = x;
  }
  return best;
}

// Settled P&L of `size` contracts bought at `price` plus `fee`.
export function tapePnl(entry, result, size, fee) {
  return (entry.side === result ? size : 0) - entry.price * size - fee;
}

// ---------------------------------------------------------------------------
// The pre-registered grid (--grid in scripts/m15-tape-backtest.mjs).
//
// Where, if anywhere, is a coin's 15-minute market mispriced? Each cell is a
// decision point x a price band; the band's side of 50c says whether the
// side bought is the favourite or the underdog. At each point the decision
// is the FIRST taker buy of each side in the GRID_LOOK_MS after it: the
// price somebody paid for that side as the point arrived. One point per
// slice the user named (10-5 min, 5-2 min, 2-1 min, 45-15s), decided as the
// slice opens, because reading every trade in a 10-minute span is ~17 pages
// a Bitcoin window (~200k requests for four months) where this is one.
//
// The choosing rule is fixed here, before any run: on the TRAIN days only,
// the cell with the highest t (by day) among cells with at least
// GRID_MIN_TRAIN trades; ties to the cell with more trades. Only that cell's
// TEST row is the result. The full table is printed for reference and is
// not a second chance to choose.
export const GRID_POINTS = [600, 300, 120, 45];
export const GRID_LOOK_MS = 15000;
export const GRID_MIN_TRAIN = 150;
export const GRID_BANDS = [
  { side: "underdog", lo: 0.03, hi: 0.20 },
  { side: "underdog", lo: 0.20, hi: 0.35 },
  { side: "underdog", lo: 0.35, hi: 0.50 },
  { side: "favourite", lo: 0.51, hi: 0.65 },
  { side: "favourite", lo: 0.65, hi: 0.80 },
  { side: "favourite", lo: 0.80, hi: 0.97, last: true },
];

// Band index of a price, or -1. Half-open [lo, hi) except the top band,
// which includes 0.97 as p75 does. 0.50 itself belongs to no band.
export function bandOf(price) {
  for (let i = 0; i < GRID_BANDS.length; i++) {
    const b = GRID_BANDS[i];
    if (price >= b.lo - 1e-9 && (b.last ? price <= b.hi + 1e-9 : price < b.hi - 1e-9)) return i;
  }
  return -1;
}

// The first taker buy of each side at or after `from` and before
// `from + lookMs`: { yes, no }, either null.
export function firstBuys(trades, from, lookMs = GRID_LOOK_MS) {
  const out = { yes: null, no: null };
  for (const x of trades) {
    if (!x || x.t < from || x.t >= from + lookMs) continue;
    if (!out[x.side] || x.t < out[x.side].t) out[x.side] = x;
  }
  return out;
}

// The fixed choosing rule. cells: [{ key, train: dayStats-like {n, t} }].
export function pickCell(cells, minTrain = GRID_MIN_TRAIN) {
  let best = null;
  for (const c of cells) {
    if (!c.train || c.train.n < minTrain || c.train.t == null) continue;
    if (!best || c.train.t > best.train.t + 1e-12 || (Math.abs(c.train.t - best.train.t) <= 1e-12 && c.train.n > best.train.n)) best = c;
  }
  return best;
}
