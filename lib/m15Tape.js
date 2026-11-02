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
