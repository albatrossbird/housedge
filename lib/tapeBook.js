// A Kalshi touch inferred from the TRADE TAPE, for windows whose book was
// never recorded (the altcoin 15-minute series before m15c/, 2026-10-29).
//
// A taker who bought YES at p met an offer at p, so p was the YES ask at
// that instant; a taker who bought NO at q met a YES bid of 1 - q. So the
// touch at t is the last print of each side at or before t, if it is at
// most `staleMs` old. Either side older than that is unknown (null), which
// the sharp-move decider reads as "no two-sided book" and passes over.
//
// The FILL is read the same way: an order for `side` with limit L sent at
// t lands at t + delayMs; the first print of that side in the next
// `windowMs` says what the ask was then. At or under L: filled, at that
// print's price. Over L: missed. No print at all: UNKNOWN, counted apart
// and never scored as either.
//
// Both are proxies. The last print can be older than the book's real
// move, and a print shows the ask was AT that price, not how much stood
// there. Validate on KXBTC15M, where the book is recorded, before reading
// any other series.

import { atOrBefore } from "./brtiLag.js";

const r4 = x => Math.round(x * 10000) / 10000;

// trades: [{ t, side, price, count }] in time order.
export function tapeBook(trades, { staleMs = 5000 } = {}) {
  const yes = trades.filter(x => x.side === "yes"), no = trades.filter(x => x.side === "no");
  return {
    at(t) {
      const a = atOrBefore(yes, t), b = atOrBefore(no, t);
      return {
        ask: a && t - a.t <= staleMs ? a.price : null,
        bid: b && t - b.t <= staleMs ? r4(1 - b.price) : null,
      };
    },
    fill(t, side, limit, { delayMs = 250, windowMs = 2000 } = {}) {
      const rows = side === "yes" ? yes : no;
      const from = t + delayMs;
      for (const x of rows) {
        if (x.t < from) continue;
        if (x.t >= from + windowMs) break;
        return x.price <= limit + 1e-9 ? { filled: true, price: x.price, count: x.count } : { filled: false, price: x.price };
      }
      return { filled: null };
    },
  };
}

// The sharp-move decider on one window, reading the tape only where it
// asks. The decider wants the touch only at an EVENT, so a replay that
// reaches an instant the tape read so far does not cover stops, fetches
// [t - 6s, t + 3s] with `fetchRange(fromMs, toMs)`, and starts again from
// the top (the decider is deterministic). Most windows need one request
// where reading the whole final two minutes took ~11 on Bitcoin.
//
// seg: { ranges: [[fromMs, toMs]...], trades: [{ t, side, price, count }] },
// shared across thresholds and mutated. Returns null or { r, fill }.
export async function decideOnTape({ ticks, seg, fetchRange, makeDecider, staleMs = 5000, delayMs = 250, windowMs = 2000 }) {
  for (;;) {
    const covered = t => seg.ranges.some(([a, b]) => t - 6000 >= a && t + 3000 <= b);
    const book = tapeBook(seg.trades, { staleMs });
    const dec = makeDecider();
    let need = null, res = null;
    for (const k of ticks) {
      const r = dec.onTick(k.t, k.v, at => { if (!covered(at)) { need = at; return null; } return book.at(at); });
      if (need != null) break;
      if (r?.order) { res = r; break; }
    }
    if (need == null) return res ? { r: res, fill: book.fill(res.t, res.order.side, res.order.limit, { delayMs, windowMs }) } : null;
    const lo = Math.floor((need - 6000) / 1000) * 1000, hi = Math.ceil((need + 3000) / 1000) * 1000;
    const got = await fetchRange(lo, hi);
    seg.ranges.push([lo, hi]);
    const seen = new Set(seg.trades.map(x => `${x.t}|${x.side}|${x.price}|${x.count}`));
    for (const x of got) if (!seen.has(`${x.t}|${x.side}|${x.price}|${x.count}`)) seg.trades.push(x);
    seg.trades.sort((a, b) => a.t - b.t);
  }
}
