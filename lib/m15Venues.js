// The 15-minute Bitcoin market on BOTH venues: Kalshi's KXBTC15M and
// Polymarket US's "BTC Up or Down: 15 min", which settle on the same index
// the same way (lib/pmus15.js has the evidence), so Up is YES and the
// outcome is Kalshi's. Pure: the archive backtest feeds it lines from the
// .us WebSocket archive (scripts/pmus15-stream.mjs writes them).
//
// What it adds over the Kalshi-only backtest:
//   - .us books as the SAME once-a-second rows the engine reads, timed on
//     the .us exchange's clock (`x`, its transactTime), so a rule can be
//     run on either venue's prices and the two compared like for like;
//   - .us fees: takers pay 0.0695 x p(1-p) rounded half-even per fill
//     (lib/venueCompare.js), makers are PAID 0.0125 x p(1-p) — a rebate,
//     modelled here as a negative fee, rounded the same way;
//   - best of both: the rule decides on Kalshi's book, and each contract
//     is bought on whichever venue is cheaper all-in at that second,
//     spilling to the other when the cheaper one runs out of depth;
//   - the .us trade tape mapped onto lib/m15Maker.js's events, so resting
//     orders can be replayed there too.
//
// TRADE SIDES on .us carry an `intent` (docs.polymarket.us, Markets
// WebSocket): BUY_LONG and SELL_SHORT take Up offers (the taker BUYS Up);
// SELL_LONG and BUY_SHORT hit Up bids (the taker SELLS Up). The docs do
// not say whether a SHORT trade's price is quoted for Up or for Down, so
// both readings are carried and the run uses the one that agrees with the
// recorded book (checkTradeSides), printing which — never an assumption.

import { pmusTakerFee } from "./venueCompare.js";

export const PMUS_MAKER_REBATE = 0.0125;   // docs.polymarket.us fees: makers are paid 0.0125 x p(1-p)
const DEPTH_WINDOW = 0.01;                 // depth within 1c of the touch, touch inclusive — as Kalshi's d[0]/d[3]
const STALE_MS = 2000;                     // a .us book older than this at a Kalshi decision is not "that second"

function roundHalfEven(x) {
  const c = x * 100, f = Math.floor(c), d = c - f;
  const r = d > 0.5 + 1e-9 ? f + 1 : d < 0.5 - 1e-9 ? f : (f % 2 === 0 ? f : f + 1);
  return r / 100;
}
export const pmusFee = (price, qty) => pmusTakerFee(price, qty);
export function pmusMakerFee(price, qty) {
  const p = Number(price);
  if (!(p > 0 && p < 1) || !(qty > 0)) return 0;
  return -roundHalfEven(PMUS_MAKER_REBATE * qty * p * (1 - p));
}

// One .us book line -> an engine row, or null. A book with either side
// empty, or crossed, has no tradeable touch; a line without the exchange's
// timestamp is dropped rather than timed on receipt (as on Kalshi).
export function pmusRow(o, close) {
  if (!o || o.k !== "pb" || !Number.isFinite(o.x) || !Number.isFinite(close)) return null;
  const b = Array.isArray(o.b) ? o.b : [], a = Array.isArray(o.a) ? o.a : [];
  if (!b.length || !a.length) return null;
  const bid = Number(b[0][0]), ask = Number(a[0][0]);
  if (!(bid > 0 && ask < 1 && bid < ask)) return null;
  const bidD1 = b.reduce((s, [p, q]) => s + (bid - p <= DEPTH_WINDOW + 1e-9 ? Number(q) : 0), 0);
  const askD1 = a.reduce((s, [p, q]) => s + (p - ask <= DEPTH_WINDOW + 1e-9 ? Number(q) : 0), 0);
  return { t: o.x, secs: (close - o.x) / 1000, bid, ask, bidD1, askD1 };
}

// .us books arrive several times a second; Kalshi's archive keeps one a
// second. The last book in each second makes the two paths comparable.
export function secondly(rows) {
  const by = new Map();
  for (const r of [...rows].sort((a, b) => a.t - b.t)) by.set(Math.floor(r.t / 1000), r);
  return [...by.values()];
}

// "yes" when the .us taker BUYS Up, "no" when it SELLS Up — the
// taker_side convention lib/m15Maker.js reads. Null for anything else.
const BUYS_UP = new Set(["ORDER_INTENT_BUY_LONG", "ORDER_INTENT_SELL_SHORT"]);
const SELLS_UP = new Set(["ORDER_INTENT_SELL_LONG", "ORDER_INTENT_BUY_SHORT"]);
export const usTakerSide = intent => (BUYS_UP.has(intent) ? "yes" : SELLS_UP.has(intent) ? "no" : null);
const isShort = intent => /_SHORT$/.test(String(intent || ""));

// The .us record as lib/m15Maker.js events, for one window. `wanted` maps
// a .us slug to { ticker, close }. Books from five minutes before the
// close (the heartbeat is 10s, so the first one is the state going in),
// cut to the top `levels`; trades from the final 130s.
export function newUsTape() { return { win: new Map(), conn: [], gaps: [] }; }
export function feedUsTape(T, o, wanted, { levels = 20 } = {}) {
  if (!o) return;
  if (o.k === "conn") { T.conn.push(o.t); return; }
  const w0 = wanted.get(o.m);
  if (!w0 || !Number.isFinite(o.x)) return;
  if (!T.win.has(w0.ticker)) T.win.set(w0.ticker, { ticker: w0.ticker, close: w0.close, finalT: w0.close - 130000, events: [] });
  const w = T.win.get(w0.ticker);
  if (o.k === "pb" && o.x >= w0.close - 300000 && o.x <= w0.close) {
    w.events.push({ k: "F", x: o.x, L: [(o.b || []).slice(0, levels), (o.a || []).slice(0, levels)] });
  } else if (o.k === "tr" && o.x >= w0.close - 130000 && o.x <= w0.close) {
    const side = usTakerSide(o.intent);
    if (side) w.events.push({ k: "TU", x: o.x, p: Number(o.p), n: Number(o.q), side, short: isShort(o.intent) });
  }
}

// A window with its .us trades read one way: `mode` "long" takes every
// trade price as Up's; "short" takes a SHORT intent's price as Down's,
// so Up's is 1 - p. Events are kept in exchange-time order.
export function resolveUsWindow(w, mode) {
  const events = w.events.map(e => e.k !== "TU" ? e
    : { k: "T", x: e.x, yp: e.short && mode === "short" ? Math.round((1 - e.p) * 10000) / 10000 : e.p, n: e.n, side: e.side });
  events.sort((a, b) => a.x - b.x || (a.k === "F" ? -1 : 1));
  return { ...w, events };
}

// What buying `side` costs on a row, and how much is there.
const buyQuote = (row, side) => (side === "yes" ? { price: row.ask, depth: row.askD1 } : { price: 1 - row.bid, depth: row.bidD1 });
export function latestAtOrBefore(rows, t) {
  let lo = 0, hi = rows.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i < 0 ? null : rows[i];
}

// Best of both: buy `size` of `side` across the two venues' rows at the
// decision instant, cheapest all-in first, spilling to the other venue
// when the first runs out of depth. A venue above the rule's price cap,
// without a fresh book, or (with requireDepth) without a known depth, is
// not used. Returns the legs, cheapest first.
export function bestOfBoth({ side, t, size, priceMax = 1, requireDepth = true, kRow, uRows, kFee, uFee }) {
  const uRow = uRows ? latestAtOrBefore(uRows, t) : null;
  const cands = [];
  const add = (venue, row, fee) => {
    if (!row) return;
    const q = buyQuote(row, side);
    if (!(q.price > 0 && q.price < 1) || q.price > priceMax + 1e-9) return;
    if (q.depth == null && requireDepth) return;
    cands.push({ venue, price: q.price, depth: q.depth, fee, unit: q.price + fee(q.price, size) / size });
  };
  add("kalshi", kRow, kFee);
  if (uRow && t - uRow.t <= STALE_MS) add("polyus", uRow, uFee);
  cands.sort((a, b) => a.unit - b.unit);
  const legs = [];
  let left = size;
  for (const c of cands) {
    const n = Math.min(left, c.depth == null ? left : Math.floor(c.depth));
    if (n < 1) continue;
    legs.push({ venue: c.venue, price: c.price, qty: n, fee: c.fee(c.price, n), unit: c.unit });
    left -= n;
    if (!left) break;
  }
  return { legs, quotes: cands };
}

// Legs -> a trade in lib/m15Backtest.js's shape (entry is the average
// price, entryFee the sum of fees), so summarize() and ruleStats() apply.
export function legsTrade(market, side, t, secs, legs) {
  const qty = legs.reduce((s, l) => s + l.qty, 0);
  if (!qty) return null;
  const spent = legs.reduce((s, l) => s + l.price * l.qty, 0), fees = legs.reduce((s, l) => s + l.fee, 0);
  const won = side === market.result;
  const pnl = (won ? qty : 0) - spent - fees;
  return { ticker: market.ticker, close: market.close, side, entryT: t, entrySecs: secs, entry: spent / qty, qty, entryFee: fees,
    exits: [], held: qty, won, pnl, pnlSlip1c: pnl, legs };
}
