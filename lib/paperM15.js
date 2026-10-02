// The paper-trading bot's pure parts (scripts/paper-m15.mjs runs them).
//
// It decides with the SAME function the backtests use (findEntry in
// lib/m15Backtest.js), on rows read live from Kalshi's /orderbook — which
// is not cached, unlike /markets (see CLAUDE.md). What it adds over the
// backtest is the step a backtest cannot see: by the time an order would
// arrive, the book has moved. So a decision is "filled" only against a
// SECOND read of the book, as a limit order at the price the rule saw:
// whatever is still offered at or better than that price fills, the rest
// does not. Nothing here or in the script places an order.

import { bookDepth } from "./m15.js";
import { kalshiTakerFee } from "./fees.js";

// The rules being tracked toward a bot. One list, read by the paper bot
// and by the daily report's backtest (`--strategy=paper`), so the two can
// never be tracking different rules. Change it in git.
export const PAPER_RULES = {
  "fav-60-120s": { entry: { side: "favourite", secsMin: 60, secsMax: 120, priceMin: 0.65, priceMax: 0.95, maxSpread: 0.03 } },
  "fav-15-45s":  { entry: { side: "favourite", secsMin: 15, secsMax: 45, priceMin: 0.80, priceMax: 0.97, maxSpread: 0.03 } },
  "fav-15-60s":  { entry: { side: "favourite", secsMin: 15, secsMax: 60, priceMin: 0.75, priceMax: 0.97, maxSpread: 0.03 } },
  "dog-60-120s": { entry: { side: "underdog",  secsMin: 60, secsMax: 120, priceMin: 0.05, priceMax: 0.35, maxSpread: 0.03 } },
};

// One /orderbook response -> an engine row (lib/m15Backtest.js shape).
// Null when the book is missing either side: no touch, no decision.
export function bookRow(resp, now, close) {
  const d = bookDepth(resp);
  if (d.book_bid == null || d.book_ask == null) return null;
  return { t: now, secs: (close - now) / 1000, bid: d.book_bid, ask: d.book_ask, bidD1: d.bid_depth_1c, askD1: d.ask_depth_1c };
}

// How many contracts a limit buy of `side` at `limit` would take from
// this book. Kalshi's book is two BID stacks: a YES buy lifts NO bids at
// p (an offer at 1-p), a NO buy hits YES bids at p (an offer at 1-p).
export function fillAgainst(resp, side, limit, qty) {
  const ob = resp?.orderbook_fp || resp?.orderbook;
  if (!ob) return 0;
  const stack = side === "yes" ? ob.no_dollars : ob.yes_dollars;
  if (!Array.isArray(stack)) return 0;
  let avail = 0;
  for (const [p, sz] of stack) {
    const offer = 1 - Number(p), n = Number(sz);
    if (Number.isFinite(offer) && Number.isFinite(n) && offer <= limit + 1e-9) avail += n;
  }
  return Math.max(0, Math.min(qty, Math.floor(avail)));
}

// Settled P&L of a paper fill, in dollars, after Kalshi's taker fee.
export function paperPnl({ side, fill_price, qty_filled, fee }, result) {
  if (!qty_filled) return 0;
  const won = side === result;
  return (won ? 1 : 0) * qty_filled - fill_price * qty_filled - (fee || 0);
}

export function paperFee(price, qty, mult) {
  return qty ? kalshiTakerFee(price, qty, mult) : 0;
}

// Of a series' open markets, the one closing next.
export function currentMarket(markets, now) {
  let best = null;
  for (const m of markets || []) {
    const close = Date.parse(m.close_time);
    if (!Number.isFinite(close) || close <= now) continue;
    if (!best || close < best.close) best = { ticker: m.ticker, close };
  }
  return best;
}

// The paper ledger per (series, rule): how often the rule fired, how
// often the book was still there when the order would have landed, and
// what the fills made once settled. A rule whose backtest wins but whose
// paper fills keep MISSING is telling you the edge lives in prices that
// are gone before an order can reach them.
export function summarizePaper(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.series}\t${r.rule}`;
    if (!groups.has(k)) groups.set(k, { series: r.series, rule: r.rule, decisions: 0, filled: 0, partial: 0, missed: 0,
      contracts: 0, settledContracts: 0, wins: 0, settledFills: 0, pnl: 0, latency: [], days: new Set() });
    const g = groups.get(k);
    g.decisions++;
    g.days.add(String(r.close_time).slice(0, 10));
    if (Number.isFinite(r.fill_latency_ms)) g.latency.push(r.fill_latency_ms);
    if (!r.qty_filled) { g.missed++; continue; }
    if (r.qty_filled < r.qty_wanted) g.partial++; else g.filled++;
    g.contracts += r.qty_filled;
    if (r.result === "yes" || r.result === "no") {
      g.settledFills++;
      g.settledContracts += r.qty_filled;
      if (r.side === r.result) g.wins++;
      g.pnl += Number(r.pnl) || 0;
    }
  }
  return [...groups.values()].map(g => {
    const lat = g.latency.sort((a, b) => a - b);
    return {
      series: g.series, rule: g.rule, days: g.days.size, decisions: g.decisions,
      filled: g.filled, partial: g.partial, missed: g.missed,
      fillRate: g.decisions ? (g.filled + g.partial) / g.decisions : null,
      contracts: g.contracts, winRate: g.settledFills ? g.wins / g.settledFills : null,
      pnl: g.pnl, pnlPerContract: g.settledContracts ? g.pnl / g.settledContracts : null,
      latencyP50: lat.length ? lat[lat.length >> 1] : null,
    };
  }).sort((a, b) => a.series.localeCompare(b.series) || a.rule.localeCompare(b.rule));
}
