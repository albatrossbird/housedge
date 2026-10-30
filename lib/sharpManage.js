// Managing a held sharp-move position 15 seconds before the close, instead
// of always holding it to settlement (scripts/m15-index.mjs, section D3).
//
// The rule was fixed before it was ever run, from results measured on
// other days (to 2026-10-21):
//   - our side's BID <= 0.30: it has become the underdog, and in the last
//     15-45s the underdog was overpriced (20-35c won 17.4% against 27.9%
//     priced). SELL everything held, a limit 1c under the bid seen.
//   - our side's ASK >= 0.75: it is the favourite, p75's floor, where the
//     late favourite made money. BUY `addQty` more, a limit 1c over the ask.
//   - otherwise hold, as now.
// Both orders fill against the recorded book `delayMs` later.
//
// A sale is booked as Kalshi books it: selling k of our side at p is buying
// k of the other side at 1 - p, and a YES plus a NO is a $1 pair. So it is
// walked on the other side's asks, and it pays the same fee formula.
//
// snap: { bids: [[p, q]...], asks: [[p, q]...] }, YES-leg prices, best
// first (lib/m15Maker.js bookCursor).

import { walkFill } from "./m15Chase.js";
import { roundKalshiFee } from "./fees.js";

export const MANAGE_SECS = 15;
export const MANAGE_DELAY_MS = 250;
export const SELL_AT = 0.30;
export const ADD_AT = 0.75;

const r4 = x => Math.round(x * 1e4) / 1e4;
const other = side => (side === "yes" ? "no" : "yes");

// The touch for one side: YES reads the book, NO is its mirror. Null
// unless both sides of the book are quoted.
export function sideQuote(snap, side) {
  const b = snap?.bids?.[0]?.[0], a = snap?.asks?.[0]?.[0];
  if (!(b > 0) || !(a > 0)) return null;
  return side === "yes" ? { bid: b, ask: a } : { bid: r4(1 - a), ask: r4(1 - b) };
}

// What the rule does at the 15-second mark: "sell", "add", "hold", or
// null when the book cannot say (one-sided or not yet read) — held.
export function decideManage(snap, side, { sellAt = SELL_AT, addAt = ADD_AT } = {}) {
  const q = sideQuote(snap, side);
  if (!q) return null;
  if (q.bid <= sellAt + 1e-9) return { action: "sell", ...q };
  if (q.ask >= addAt - 1e-9) return { action: "add", ...q };
  return { action: "hold", ...q };
}

// Fill the managing order against the book `delayMs` later (snap2).
// Returns { k, cost, fee, side }: k contracts bought of `side` (the other
// side for a sale) for `cost`, `fee` Kalshi's per-order fee.
export function fillManage(snap2, side, d, held, { addQty = 10, mult = 1, worse = 0 } = {}) {
  if (!snap2 || !d || d.action === "hold") return { k: 0, cost: 0, fee: 0, side };
  const buySide = d.action === "sell" ? other(side) : side;
  // Sell 1c under our bid seen = buy the other side 1c over its ask (1 - bid).
  const limit = d.action === "sell" ? r4(1 - d.bid + 0.01) : r4(d.ask + 0.01);
  const qty = d.action === "sell" ? held : addQty;
  const f = walkFill(snap2, buySide, Math.min(limit, 0.99), qty);
  const cost = r4(f.cost + worse * f.n);
  return { k: f.n, cost, fee: f.n ? roundKalshiFee(0.07 * mult * f.pq) : 0, side: buySide };
}

// P&L of the whole position, settled: n of `side` bought for cost + fee,
// then the managing fill m. A sale's k pairs pay $1 whatever happens.
export function managedPnl({ side, won, n, cost, fee }, m) {
  const base = (won ? n : 0) - cost - fee;
  if (!m || !m.k) return base;
  const mWins = m.side === side ? won : !won;
  return base + (mWins ? m.k : 0) - m.cost - m.fee;
}
