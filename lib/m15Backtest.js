// A strategy backtester for Kalshi's 15-minute markets, over the path the
// 15-second poller records (m15_quotes). Pure: fed each market's rows and
// its result, it trades a strategy and reports what that would have made.
// scripts/m15-backtest.mjs does the reading and printing;
// scripts/m15-backtest.test.mjs pins every rule below.
//
// WHAT A ROW IS. book_bid/book_ask are the LIVE touch (read from
// /orderbook, recorded from 2026-09-26); bid_depth_1c/ask_depth_1c are
// the contracts resting within one cent of it, touch inclusive. The
// yes_bid/yes_ask columns come through a 15s CDN cache and are not used.
//
// THE RULES THAT DECIDE WHETHER A RESULT MEANS ANYTHING:
//
//   1. No lookahead. A decision at a row sees that row and earlier ones
//      only; the settlement result is read once, at the end. A row at or
//      after the close is never tradeable — past the bell a market's
//      "price" is its settlement, and a backtester that trades it books
//      wins out of nothing (a commercial one was caught doing exactly
//      this; see lib/calibrate.js).
//   2. You pay the ASK to buy and get the BID to sell. NO is bought at
//      1 - YES bid and sold at 1 - YES ask: Kalshi's two books are two
//      bid stacks, so taking NO is hitting the YES bid queue.
//   3. Size is capped by what was resting within 1c of the touch. A null
//      depth is UNKNOWN, not zero and not unlimited, and by default the
//      entry is skipped. Fills are priced AT the touch, which flatters a
//      size reaching into the next cent — so every report carries the
//      same result with 1c worse on every fill beside it.
//   4. Fees are Kalshi's taker fee, rounded up to the cent per ORDER, on
//      entry and on any early exit. Settlement is free.
//   5. One entry per market, and the honest sample size is DAYS, not
//      trades: consecutive windows ride the same underlying.

import { kalshiTakerFee } from "./fees.js";

export const PRESETS = {
  // Buy the favourite with ~1.5 minutes left and hold. The strategy
  // lib/calibrate.js measures, run through the same engine as the rest.
  "fav-late": { entry: { side: "favourite", secsMin: 60, secsMax: 120, priceMin: 0.65, priceMax: 0.95, maxSpread: 0.03 } },
  // The same, later and more certain.
  "fav-final": { entry: { side: "favourite", secsMin: 15, secsMax: 45, priceMin: 0.80, priceMax: 0.97, maxSpread: 0.03 } },
  // The other side of that bet: the long shot, late.
  "dog-late": { entry: { side: "underdog", secsMin: 60, secsMax: 120, priceMin: 0.05, priceMax: 0.35, maxSpread: 0.03 } },
  // Mid-window favourite with a stop and a target, flat by the final minute.
  "fav-mid-managed": {
    entry: { side: "favourite", secsMin: 300, secsMax: 420, priceMin: 0.60, priceMax: 0.80, maxSpread: 0.03 },
    exit: { takeProfitCents: 10, stopLossCents: 15, exitAtSecs: 60 },
  },
  // Follow a 10c move over the last minute, hold to settlement.
  "momentum": { entry: { side: "momentum", lookbackSecs: 60, minMoveCents: 10, secsMin: 120, secsMax: 600, priceMin: 0.30, priceMax: 0.85, maxSpread: 0.03 } },
  // Fade the same move.
  "fade": { entry: { side: "fade", lookbackSecs: 60, minMoveCents: 10, secsMin: 120, secsMax: 600, priceMin: 0.15, priceMax: 0.70, maxSpread: 0.03 } },
};

const num = v => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// One recorded row -> the engine's shape. Rows without a live touch are
// dropped: they are either from before 2026-09-26 or a failed book read.
export function toPathRow(r) {
  const bid = num(r.book_bid), ask = num(r.book_ask), secs = num(r.secs_to_close);
  const t = typeof r.observed_at === "string" ? Date.parse(r.observed_at) : num(r.observed_at);
  if (bid == null || ask == null || secs == null || !Number.isFinite(t)) return null;
  return { t, secs, bid, ask, bidD1: num(r.bid_depth_1c), askD1: num(r.ask_depth_1c) };
}

// One WebSocket-archive book line (k:"b", scripts/m15-stream.mjs) -> the
// engine's shape. `d` is [bid 1c, 3c, 5c, ask 1c, 3c, 5c], touch
// inclusive, YES-leg throughout.
//
// The time is the EXCHANGE'S (`x`, the last change the book includes),
// not the box's receive time `t`. Before 2026-09-30 13:16 UTC the
// recorder fell up to 13 minutes behind its socket: the books it wrote
// were correct but late, and stamping them on receipt would put a book
// minutes after the moment it described — a backtest reading it would
// be trading on prices the market had already left. Without `x` the line
// is dropped rather than guessed.
export function archiveRow(o, close) {
  if (!o || o.k !== "b") return null;
  const bid = num(o.b), ask = num(o.a), t = num(o.x);
  if (bid == null || ask == null || t == null || !Number.isFinite(close)) return null;
  const d = Array.isArray(o.d) ? o.d : [];
  return { t, secs: (close - t) / 1000, bid, ask, bidD1: num(d[0]), askD1: num(d[3]) };
}

// What it costs to BUY a side at this row, and how much is there.
function buyQuote(row, side) {
  return side === "yes" ? { price: row.ask, depth: row.askD1 } : { price: 1 - row.bid, depth: row.bidD1 };
}
// What you get to SELL a held side at this row, and how much is there.
function sellQuote(row, side) {
  return side === "yes" ? { price: row.bid, depth: row.bidD1 } : { price: 1 - row.ask, depth: row.askD1 };
}

// The mid LOOKBACK seconds ago, from rows already seen. Null when the
// path does not reach back that far — no signal, rather than a guess.
function pastMid(rows, i, lookbackSecs) {
  const target = rows[i].t - lookbackSecs * 1000;
  for (let j = i - 1; j >= 0; j--) if (rows[j].t <= target) return (rows[j].bid + rows[j].ask) / 2;
  return null;
}

function chooseSide(e, rows, i) {
  const r = rows[i], mid = (r.bid + r.ask) / 2;
  switch (e.side) {
    case "yes": case "no": return e.side;
    case "favourite": return mid >= 0.5 ? "yes" : "no";
    case "underdog": return mid >= 0.5 ? "no" : "yes";
    case "momentum": case "fade": {
      const past = pastMid(rows, i, e.lookbackSecs ?? 60);
      if (past == null) return null;
      const move = (mid - past) * 100;
      if (Math.abs(move) < (e.minMoveCents ?? 10)) return null;
      const up = move > 0 ? "yes" : "no";
      return e.side === "momentum" ? up : (up === "yes" ? "no" : "yes");
    }
    default: throw new Error(`unknown side rule: ${e.side}`);
  }
}

// Trade one market. rows: its path, any order (sorted here). result:
// "yes" | "no". Returns the trade, or null if the strategy never entered.
// THE ENTRY DECISION, shared with the paper bot (scripts/paper-m15.mjs),
// so the rule that is backtested is the rule that is traded. Given the
// rows seen so far (no later row may be passed — that is the caller's
// no-lookahead guarantee), returns the first row at which the strategy
// would buy, or null: { i, row, side, price, depth, qty }.
export function findEntry(strategy, market, path, { size = 10, requireDepth = true, from = 0 } = {}) {
  const e = strategy.entry || {};
  for (let i = from; i < path.length; i++) {
    const r = path[i];
    if (!(r.t < market.close && r.secs > 0)) continue;
    if (r.secs < (e.secsMin ?? 0) || r.secs > (e.secsMax ?? Infinity)) continue;
    if (e.maxSpread != null && r.ask - r.bid > e.maxSpread + 1e-9) continue;
    const side = chooseSide(e, path, i);
    if (!side) continue;
    const q = buyQuote(r, side);
    if (!(q.price > 0 && q.price < 1)) continue;
    if (q.price < (e.priceMin ?? 0) - 1e-9 || q.price > (e.priceMax ?? 1) + 1e-9) continue;
    if (q.depth == null && requireDepth) continue;
    const qty = Math.min(size, q.depth == null ? size : Math.floor(q.depth));
    if (qty < 1) continue;
    return { i, row: r, side, price: q.price, depth: q.depth, qty };
  }
  return null;
}

export function runMarket(strategy, market, rows, { size = 10, mult = 1, requireDepth = true } = {}) {
  const x = strategy.exit || null;
  const path = rows.filter(r => r && r.t < market.close && r.secs > 0).sort((a, b) => a.t - b.t);
  const hit = findEntry(strategy, market, path, { size, requireDepth });
  if (hit) {
    const { i, row: r, side, qty } = hit, q = { price: hit.price };

    const trade = { ticker: market.ticker, close: market.close, side, entryT: r.t, entrySecs: r.secs,
      entry: q.price, qty, entryFee: kalshiTakerFee(q.price, qty, mult), exits: [], held: qty };

    if (x) {
      for (let j = i + 1; j < path.length && trade.held > 0; j++) {
        const s = path[j], sq = sellQuote(s, side);
        if (!(sq.price > 0 && sq.price < 1)) continue;
        const why = x.takeProfitCents != null && sq.price >= q.price + x.takeProfitCents / 100 - 1e-9 ? "target"
          : x.stopLossCents != null && sq.price <= q.price - x.stopLossCents / 100 + 1e-9 ? "stop"
          : x.exitAtSecs != null && s.secs <= x.exitAtSecs ? "time" : null;
        if (!why) continue;
        if (sq.depth == null && requireDepth) continue;
        const n = Math.min(trade.held, sq.depth == null ? trade.held : Math.floor(sq.depth));
        if (n < 1) continue;
        trade.exits.push({ t: s.t, secs: s.secs, price: sq.price, qty: n, fee: kalshiTakerFee(sq.price, n, mult), why });
        trade.held -= n;
      }
    }
    return settle(trade, market.result);
  }
  return null;
}

// P&L in dollars. `slip` charges every fill that many dollars worse per
// contract: paid more on entry, received less on exit.
function settle(t, result, slip = 0) {
  const won = t.side === result;
  let pnl = -(t.entry + slip) * t.qty - t.entryFee;
  for (const x of t.exits) pnl += (x.price - slip) * x.qty - x.fee;
  pnl += (won ? 1 : 0) * t.held;
  if (!slip) { t.won = won; t.pnl = pnl; t.pnlSlip1c = settle({ ...t, exits: t.exits }, result, 0.01).pnl; }
  return slip ? { pnl } : t;
}

// Summary over trades, with DAYS as the sample (rule 5).
export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const byDay = new Map();
  for (const t of trades) {
    const d = new Date(t.close).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + t.pnl);
  }
  const days = [...byDay.values()];
  const mean = days.reduce((a, b) => a + b, 0) / days.length;
  const sd = days.length > 1 ? Math.sqrt(days.reduce((s, v) => s + (v - mean) ** 2, 0) / (days.length - 1)) : null;
  let cum = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.entryT - b.entryT)) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const contracts = trades.reduce((s, t) => s + t.qty, 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0), pnlSlip = trades.reduce((s, t) => s + t.pnlSlip1c, 0);
  return {
    n, contracts, days: days.length,
    winRate: trades.filter(t => t.won).length / n,
    avgEntry: trades.reduce((s, t) => s + t.entry, 0) / n,
    early: trades.filter(t => t.exits.length).length,
    pnl, pnlPerContract: pnl / contracts, pnlSlip1c: pnlSlip,
    perDay: mean, perDaySd: sd, tDays: sd > 1e-9 ? mean / (sd / Math.sqrt(days.length)) : null,
    maxDrawdown: dd,
  };
}

// The same trades split into the EARLIER and LATER half of their days.
// A rule picked because it looked good over all the days is partly fitted
// to them; whether it holds on the half it was not judged on is the first
// check that it is a pattern rather than a description of the sample.
// With an odd number of days the middle one goes to the later half.
export function splitHalves(trades) {
  const day = t => new Date(t.close).toISOString().slice(0, 10);
  const days = [...new Set(trades.map(day))].sort();
  const cut = Math.floor(days.length / 2);
  const early = new Set(days.slice(0, cut));
  return {
    early: summarize(trades.filter(t => early.has(day(t)))),
    late: summarize(trades.filter(t => !early.has(day(t)))),
  };
}

// A --strategy value is one strategy ({entry, exit}) or a map of named
// ones ({"name": {entry, exit}, ...}), so a handful of variants share one
// read of the recorded path instead of each paying for its own.
export function parseStrategies(json) {
  const v = JSON.parse(json);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected a JSON object");
  if (v.entry) return { custom: v };
  const out = {};
  for (const [name, s] of Object.entries(v)) {
    if (!s || typeof s !== "object" || !s.entry) throw new Error(`strategy "${name}" has no entry rule`);
    out[name] = s;
  }
  if (!Object.keys(out).length) throw new Error("no strategies in the map");
  return out;
}
