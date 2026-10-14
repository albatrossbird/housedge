// Do large trades on the 15-minute markets know something?
//
// Kalshi and Polymarket US publish trades with no trader identity — size,
// price, side and time only — so "whale tracking" there can only mean big
// prints. Two questions, per series and venue:
//
//   1. CALIBRATION. A taker who pays p for a side is claiming it wins more
//      than p of the time. Does the claim hold, and does it hold BETTER for
//      big trades than small ones? "edge" is won - paid - fee per contract,
//      the same arithmetic as the backtests' "priced vs won".
//   2. FOLLOWING. After a big taker trade, buy the same side L ms later at
//      the price the next taker on that side paid — the price the book was
//      still offering — and hold to settlement. L = 0 is the big trade's own
//      price, which nobody following it could have had.
//
// Every trade counts once, whatever its size, so a few huge prints cannot
// stand in for the band; results are by DAY (windows on one day share an
// underlying), like every other report here.

export const SIZE_BANDS = [[1, 99], [100, 999], [1000, 9999], [10000, Infinity]];
export const TIME_BANDS = [[0, 60], [60, 180], [180, 420], [420, 900]];
export const FOLLOW_MIN = [1000, 10000];
export const FOLLOW_DELAYS_MS = [0, 250, 1000, 5000, 15000];

export const bandOf = (bands, v) => bands.findIndex(([lo, hi]) => v >= lo && v <= hi);

// One settled window. `trades`: [{ x, n, side: "yes"|"no", paid }] — the
// exchange's ms, contracts, the side the TAKER bought, and the price the
// taker paid for that side. `fee(paid, qty)` is one order's taker fee in
// dollars. Returns per-trade records and follow records.
export function windowRecords(trades, { close, result, fee, followQty = 10 }) {
  const ts = trades.filter(t => Number.isFinite(t.x) && t.x < close && t.n > 0 && t.paid > 0 && t.paid < 1 && (t.side === "yes" || t.side === "no"))
    .sort((a, b) => a.x - b.x);
  const rows = [], follows = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i], won = t.side === result ? 1 : 0, secs = (close - t.x) / 1000;
    rows.push({ secs, n: t.n, paid: t.paid, won, edge: won - t.paid - fee(t.paid, t.n) / t.n });
    if (t.n < FOLLOW_MIN[0]) continue;
    for (const L of FOLLOW_DELAYS_MS) {
      let price = null;
      if (L === 0) price = t.paid;
      else for (let j = i + 1; j < ts.length; j++) {
        if (ts[j].x < t.x + L || ts[j].side !== t.side) continue;
        price = ts[j].paid; break;
      }
      follows.push({ n: t.n, secs, delay: L, filled: price != null,
        edge: price == null ? null : won - price - fee(price, followQty) / followQty });
    }
  }
  return { rows, follows };
}

// Accumulators keyed by band, each keeping per-day sums for a t-statistic
// across DAYS rather than trades.
export function newAgg() { return new Map(); }
export function add(agg, key, day, edge, extra = {}) {
  if (!agg.has(key)) agg.set(key, { n: 0, sum: 0, won: 0, paid: 0, ctrs: 0, byDay: new Map() });
  const a = agg.get(key);
  a.n++; a.sum += edge; a.won += extra.won ?? 0; a.paid += extra.paid ?? 0; a.ctrs += extra.ctrs ?? 0;
  const d = a.byDay.get(day) || { n: 0, sum: 0 }; d.n++; d.sum += edge; a.byDay.set(day, d);
}
export function summary(a) {
  if (!a || !a.n) return null;
  const days = [...a.byDay.values()].map(d => d.sum / d.n);
  const m = days.reduce((s, v) => s + v, 0) / days.length;
  const sd = days.length > 1 ? Math.sqrt(days.reduce((s, v) => s + (v - m) ** 2, 0) / (days.length - 1)) : 0;
  return { n: a.n, edge: a.sum / a.n, won: a.won / a.n, paid: a.paid / a.n, ctrs: a.ctrs, days: days.length,
    // Under three days, or days that agree to rounding, a t is noise dressed as a number.
    t: days.length >= 3 && sd > 1e-9 ? m / (sd / Math.sqrt(days.length)) : null };
}
