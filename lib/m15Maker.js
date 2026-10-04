// RESTING-ORDER entries for the 15-minute rules, replayed against
// Kalshi's book change by change in each window's final two minutes.
//
// The taker backtest (lib/m15Backtest.js) buys at the ask the moment a
// rule fires. A resting order instead sits at the bid and waits for a
// seller: it saves the spread and, on a series whose fee_type is
// "quadratic", the whole fee — makers pay nothing there. The catch it
// has to measure is SELECTION: a resting bid on the favourite fills when
// someone sells the favourite, which is disproportionately when it is
// about to lose. So every result reports the win rate of decisions that
// filled beside those that did not.
//
// THE DATA. In each window's final two minutes the WebSocket archive
// holds every book change ("full" + "d") and every trade ("tr"), on
// Kalshi's clock. Every rule tracked toward a bot acts inside that
// stretch. Decisions come from the SAME findEntry on the once-a-second
// rows the taker backtest uses, so the two are compared on identical
// moments; only the execution differs.
//
// THE FILL MODEL. The order is posted at the decision plus LATENCY.
//   join     at the bid, BEHIND everything resting there. Only trades at
//            our price move it forward: cancels ahead of us are assumed
//            never to happen. Pessimistic, by construction.
//   front    at the bid, AHEAD of everything resting there — the
//            optimistic bound. The truth lies between join and front.
//   improve  one cent better than the bid, alone at a new level, when
//            the spread is at least two cents; otherwise it joins.
// A trade at our price fills us once the queue ahead is used up; a trade
// THROUGH our price (worse for the seller) means our level was cleared
// first, so the rest fills. Taker trades on the other side never fill a
// bid. The order is cancelled CUTOFF seconds before the close; with
// `fallback`, whatever is unfilled is then bought at the ask, as a taker,
// if the ask is still inside the rule's price band.
//
// Trade sides: taker_side "no" means the taker bought NO, which is
// hitting YES bids; "yes" means lifting YES offers, which are NO bids.
// checkTradeSides() tests that reading against the book on every run,
// because a mapping read backwards would still produce plausible fills.
//
// A window whose record was interrupted (a sequence gap or a socket
// event in the final two minutes) is not replayed: between the
// interruption and the next full snapshot the book is not known.

import { kalshiTakerFee, kalshiMakerFee } from "./fees.js";

export const MAKER_MODES = ["join", "front", "improve"];
const K = p => Math.round(p * 10000);
const TICK = 0.01;

export function newTape() {
  return { win: new Map(), conn: [], gaps: [] };
}

// One parsed archive line. `wanted` maps ticker -> close (ms); only those
// windows' final two minutes are kept, so a week of the archive fits in
// memory one window at a time.
export function feedTape(T, o, wanted) {
  if (!o) return;
  if (o.k === "conn") { T.conn.push(o.t); return; }
  if (o.k === "gap") {
    const ms = (Array.isArray(o.m) ? o.m : [o.m]).filter(m => wanted.has(m));
    if (ms.length) T.gaps.push({ t: o.t, m: ms });
    return;
  }
  const close = wanted.get(o.m);
  if (close == null) return;
  if (!T.win.has(o.m)) T.win.set(o.m, { ticker: o.m, close, finalT: null, events: [] });
  const w = T.win.get(o.m);
  const x = Number.isFinite(o.x) ? o.x : null;
  if (o.k === "final") w.finalT = o.t;
  else if (o.k === "full") w.events.push({ k: "F", x, L: o.L || [[], []] });
  else if (o.k === "d") w.events.push({ k: "D", x, sd: o.sd, p: o.p, q: o.q });
  else if (o.k === "tr" && x != null && x >= close - 130000 && x <= close) w.events.push({ k: "T", x, yp: o.yp, n: o.n, side: o.side });
}

// Was the record interrupted between the final-window mark and the close?
export function disrupted(T, w) {
  if (w.finalT == null) return "no final-window record";
  const lo = w.finalT - 1000, hi = w.close + 2000;
  if (T.conn.some(t => t >= lo && t <= hi)) return "socket event";
  if (T.gaps.some(g => g.t >= lo && g.t <= hi && g.m.includes(w.ticker))) return "sequence gap";
  if (!w.events.some(e => e.k === "F")) return "no full book";
  return null;
}

// The window's events on one timeline: Kalshi's clock, carried forward
// where a line has none, never running backwards.
function timeline(w) {
  let last = null;
  return w.events.map(e => {
    let t = e.x ?? last ?? (w.finalT ?? 0);
    if (last != null && t < last) t = last;
    last = t;
    return { ...e, t };
  });
}

function makeBook() {
  const bids = new Map(), asks = new Map();
  let ready = false;
  return {
    apply(e) {
      if (e.k === "F") {
        bids.clear(); asks.clear();
        for (const [p, q] of e.L[0] || []) if (q > 0) bids.set(K(p), q);
        for (const [p, q] of e.L[1] || []) if (q > 0) asks.set(K(p), q);
        ready = true;
      } else if (e.k === "D" && ready) {
        const side = e.sd === "b" ? bids : asks, k = K(e.p);
        const n = Math.round(((side.get(k) || 0) + e.q) * 100) / 100;
        if (n > 0) side.set(k, n); else side.delete(k);
      }
    },
    get ready() { return ready; },
    touch() {
      let b = null, a = null;
      for (const k of bids.keys()) if (b == null || k > b) b = k;
      for (const k of asks.keys()) if (a == null || k < a) a = k;
      return { bid: b == null ? null : b / 10000, ask: a == null ? null : a / 10000 };
    },
    bidSize: p => bids.get(K(p)) || 0,
    askSize: p => asks.get(K(p)) || 0,
    levels(n) {
      const side = (m, dir) => [...m].sort((a, b) => dir * (a[0] - b[0])).slice(0, n).map(([k, q]) => [k / 10000, q]);
      return { bids: side(bids, -1), asks: side(asks, 1) };
    },
  };
}

// Do the recorded trade sides read the way this module assumes? A taker
// buying YES trades at (or near) the ask, one buying NO at (or near) the
// bid. A trade agrees when it sits nearer the side the mapping says AND
// within 2c of it — nearness alone would accept a price read on the wrong
// scale (a Down price of 16c is "nearer the bid" of an 84/85 Up book).
// Trades equidistant from both sides say nothing and are not counted.
const SIDE_TOLERANCE = 0.02;
export function checkTradeSides(w) {
  const book = makeBook();
  let agree = 0, total = 0;
  for (const e of timeline(w)) {
    if (e.k !== "T") { book.apply(e); continue; }
    if (!book.ready) continue;
    const { bid, ask } = book.touch();
    if (bid == null || ask == null || ask <= bid) continue;
    const dBid = Math.abs(e.yp - bid), dAsk = Math.abs(e.yp - ask);
    if (Math.abs(dBid - dAsk) < 1e-9) continue;
    total++;
    const dExp = e.side === "yes" ? dAsk : dBid, dOther = e.side === "yes" ? dBid : dAsk;
    if (dExp < dOther && dExp <= SIDE_TOLERANCE + 1e-9) agree++;
  }
  return { agree, total };
}

// One decision, executed as a resting order. decision: { t, side, qty,
// priceMax }. Returns what filled, or why nothing could be posted.
export function simulateMaker(w, decision, { mode = "join", latencyMs = 100, cutoffSecs = 5, fallback = false } = {}) {
  const ev = timeline(w), book = makeBook();
  const landT = decision.t + latencyMs, cutoffT = w.close - cutoffSecs * 1000;
  if (landT >= cutoffT) return { status: "late" };
  let i = 0;
  for (; i < ev.length && ev[i].t <= landT; i++) if (ev[i].k !== "T") book.apply(ev[i]);
  if (!book.ready) return { status: "noBook" };
  const { bid, ask } = book.touch();
  const yes = decision.side === "yes";
  // Our side's bid, and the best offer we must not cross (post-only).
  const base = yes ? bid : (ask == null ? null : 1 - ask);
  const offer = yes ? ask : (bid == null ? null : 1 - bid);
  if (base == null || offer == null) return { status: "noBook" };
  let limit = base, improved = false;
  if (mode === "improve" && base + TICK < offer - 1e-9) { limit = Math.round((base + TICK) * 100) / 100; improved = true; }
  const levelSize = yes ? book.bidSize(limit) : book.askSize(1 - limit);
  // Behind the whole level unless we are at the front by assumption
  // ("front") or alone at a price we made ("improve" that could improve).
  let ahead = mode === "front" || improved ? 0 : levelSize;
  const queueAhead = ahead;

  const qty = decision.qty;
  let filled = 0, firstFillT = null;
  for (; i < ev.length && filled < qty; i++) {
    const e = ev[i];
    if (e.t >= cutoffT) break;
    if (e.k !== "T") { book.apply(e); continue; }
    // A YES bid fills against takers SELLING YES (taker_side "no"); a NO
    // bid at q is a YES offer at 1-q and fills against takers buying YES.
    if (yes ? e.side !== "no" : e.side !== "yes") continue;
    const ourYesPx = yes ? limit : 1 - limit;
    const through = yes ? e.yp < ourYesPx - 1e-9 : e.yp > ourYesPx + 1e-9;
    const at = Math.abs(e.yp - ourYesPx) < 1e-9;
    if (!through && !at) continue;
    let n;
    if (through) n = qty - filled;
    else { const used = Math.min(ahead, e.n); ahead -= used; n = Math.min(qty - filled, e.n - used); }
    if (n > 0) { filled += n; if (firstFillT == null) firstFillT = e.t; }
  }
  // Bring the book up to the cutoff for the fallback's price.
  for (; i < ev.length && ev[i].t < cutoffT; i++) if (ev[i].k !== "T") book.apply(ev[i]);

  let takeQty = 0, takePrice = null;
  if (fallback && filled < qty) {
    const t = book.touch();
    const px = yes ? t.ask : (t.bid == null ? null : 1 - t.bid);
    if (px != null && px > 0 && px < 1 && px <= (decision.priceMax ?? 1) + 1e-9) {
      const size = yes ? book.askSize(px) : book.bidSize(1 - px);
      takeQty = Math.min(qty - filled, Math.floor(size));
      if (takeQty > 0) takePrice = px; else takeQty = 0;
    }
  }
  return { status: "ok", limit, improved, queueAhead, filled, firstFillSecs: firstFillT == null ? null : (w.close - firstFillT) / 1000, takeQty, takePrice };
}

// A simulated execution -> a trade in lib/m15Backtest.js's shape, so the
// same summarize() and day statistics apply. Null when nothing filled.
// Fees default to Kalshi's for the series; another venue passes its own
// `makerFee(price, qty)` / `takerFee(price, qty)` — a negative maker fee
// is a rebate (lib/m15Venues.js).
export function makerTrade(market, decision, sim, { mult = 1, feeType, makerFee: mf = null, takerFee: tf = null } = {}) {
  if (sim.status !== "ok" || sim.filled + sim.takeQty <= 0) return null;
  const won = decision.side === market.result;
  const makerFee = mf ? mf(sim.limit, sim.filled) : kalshiMakerFee(sim.limit, sim.filled, mult, feeType);
  if (makerFee == null) return null;
  const takerFee = sim.takeQty ? (tf ? tf(sim.takePrice, sim.takeQty) : kalshiTakerFee(sim.takePrice, sim.takeQty, mult)) : 0;
  const qty = sim.filled + sim.takeQty;
  const cost = sim.limit * sim.filled + (sim.takePrice || 0) * sim.takeQty + makerFee + takerFee;
  const pnl = (won ? qty : 0) - cost;
  return {
    ticker: market.ticker, close: market.close, side: decision.side, entryT: decision.t, entrySecs: decision.secs,
    entry: cost / qty, qty, entryFee: makerFee + takerFee, exits: [], held: qty, won, pnl, pnlSlip1c: pnl,
    makerQty: sim.filled, takerQty: sim.takeQty,
  };
}

// Selection: of the decisions where an order was posted, did the ones
// that filled win as often as the ones that did not? The outcome of an
// unfilled decision is what the side did at settlement — known, because
// the decision is.
export function selection(rows) {
  const f = rows.filter(r => r.filled > 0), u = rows.filter(r => r.filled === 0);
  const rate = a => a.length ? a.filter(r => r.won).length / a.length : null;
  return { posted: rows.length, filled: f.length, unfilled: u.length, winFilled: rate(f), winUnfilled: rate(u) };
}

// The book as it stood at each of `times` (exchange ms, any order): every
// change up to and including that instant applied. Top `levels` each side,
// YES-leg prices, bids best-first (descending), asks best-first
// (ascending). Null for an instant before the window's first full book.
// One pass over the record for all the instants.
export function snapshotsAt(w, times, levels = 10) {
  const ev = timeline(w), book = makeBook(), out = new Map();
  const want = [...new Set(times)].sort((a, b) => a - b);
  let i = 0;
  for (const t of want) {
    for (; i < ev.length && ev[i].t <= t; i++) if (ev[i].k !== "T" && ev[i].k !== "TU") book.apply(ev[i]);
    out.set(t, book.ready ? book.levels(levels) : null);
  }
  return out;
}
