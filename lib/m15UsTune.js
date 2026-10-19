// Polymarket US variants of an entry rule, for a tune-on-one-half,
// test-on-the-other comparison (scripts/m15-archive-backtest.mjs --us-tune).
//
// Three ways to decide, each filled on the .us book DELAY ms later:
//   us-once     the rule on .us's once-a-second rows (the last .us book of
//               each second it published one);
//   us-change   the rule on every .us book;
//   kalshi      the rule on KALSHI's once-a-second rows. Kalshi carries the
//               volume and sets the price; .us is only where the order goes.
//               The order is priced off the .us book standing at the decision
//               instant (no older than STALE_MS), for the .us contracts within
//               1c of its touch, and skipped if .us offers that side above the
//               rule's cap. Kalshi's book chooses WHEN and WHICH SIDE; .us's
//               book sets the price and size, so nothing is bought at a price
//               .us was not showing.
// and two ways to price the order: at the price seen, or 1c above it (never
// above the rule's cap). Every fill pays the walked .us price.

import { findEntry } from "./m15Backtest.js";
import { bookCursor } from "./m15Maker.js";
import { latestAtOrBefore } from "./m15Venues.js";
import { walkFill } from "./m15Chase.js";

export const US_TUNE_LIMITS = [{ key: "seen", cents: 0 }, { key: "+1c", cents: 1 }];
export const US_TUNE_DELAYS_MS = [100, 250];
export const STALE_MS = 2000;

const r4 = x => Math.round(x * 10000) / 10000;
const limitFor = (price, cents, priceMax) => Math.min(r4(price + cents / 100), Math.max(price, priceMax));

// One window, Kalshi deciding. Returns { [name]: null | { skip } |
// { [limitKey]: { [delay]: { n, cost, fills, side, price, qty } | { unknown } } } }.
export function kalshiDecidesUs({ market, kRows, usRows, ws, strategies, size = 10, requireDepth = true,
  limits = US_TUNE_LIMITS, delays = US_TUNE_DELAYS_MS, staleMs = STALE_MS, levels = 20 }) {
  const out = {}, queries = [];
  for (const [name, strat] of strategies) {
    const h = findEntry(strat, market, kRows, { size, requireDepth });
    if (!h) { out[name] = null; continue; }
    const t = h.row.t, u = latestAtOrBefore(usRows, t);
    if (!u || t - u.t > staleMs) { out[name] = { skip: "stale .us book" }; continue; }
    const side = h.side, priceMax = strat.entry?.priceMax ?? 1;
    const price = side === "yes" ? u.ask : r4(1 - u.bid), depth = side === "yes" ? u.askD1 : u.bidD1;
    if (!(price > 0 && price < 1)) { out[name] = { skip: "no .us price" }; continue; }
    if (price > priceMax + 1e-9) { out[name] = { skip: ".us above the cap" }; continue; }
    const qty = Math.min(size, Math.floor((depth ?? 0) + 1e-9));
    if (qty < 1) { out[name] = { skip: "no .us depth" }; continue; }
    out[name] = {};
    for (const l of limits) {
      out[name][l.key] = {};
      for (const delay of delays) queries.push({ name, l, delay, at: t + delay, side, price, qty, limit: limitFor(price, l.cents, priceMax) });
    }
  }
  queries.sort((a, b) => a.at - b.at);
  const cursor = queries.length ? bookCursor(ws, levels) : null;
  for (const q of queries) {
    let res;
    if (q.at >= market.close) res = { n: 0, side: q.side, price: q.price, qty: q.qty };
    else {
      const snap = cursor.at(q.at);
      if (!snap) res = { unknown: true };
      else { const f = walkFill(snap, q.side, q.limit, q.qty); res = { ...f, side: q.side, price: q.price, qty: q.qty }; }
    }
    out[q.name][q.l.key][q.delay] = res;
  }
  return out;
}

// The pre-committed choice: each variant's score is the LOWER of its tune-half
// t at the two delays (a variant must hold up at both latencies), and the
// highest score wins. Ties go to the earlier variant in the list.
export function chooseVariant(scored) {
  let best = null;
  for (const v of scored) if (Number.isFinite(v.score) && (!best || v.score > best.score)) best = v;
  return best;
}

// Split days in two: the first half (by distinct day, earlier days) tunes,
// the rest tests. An explicit split date (YYYY-MM-DD, first TEST day) wins.
export function splitDays(days, splitAt = null) {
  const d = [...new Set(days)].sort();
  if (splitAt) return { tune: d.filter(x => x < splitAt), test: d.filter(x => x >= splitAt) };
  const k = Math.floor(d.length / 2);
  return { tune: d.slice(0, k), test: d.slice(k) };
}
