// lib/m15Maker.js — resting-order entries replayed against the final two
// minutes' book and trades. Hand-built windows, every number worked out.
//
// Pinned here:
//   1. "join" waits behind everything resting at its price: only trades at
//      that price move it forward, and a trade through the price fills the
//      rest. "front" is the optimistic bound. Trades before the order
//      lands do not count, and taker BUYS never fill a bid.
//   2. NO is a bid at 1 - YES ask, filled by takers buying YES.
//   3. "improve" posts a cent inside the spread only when it is 2c+ wide,
//      and otherwise joins — BEHIND the queue, not in front of it.
//   4. Nothing fills after the cutoff; the fallback then buys the rest at
//      the ask, only inside the rule's price band and the size resting.
//   5. Maker fees follow the series' fee_type; an unknown one is null.
//   6. A window with a socket event or sequence gap is not replayed.
//   7. The trade-side check agrees with a correct mapping and flags an
//      inverted one.
import { newTape, feedTape, disrupted, simulateMaker, makerTrade, checkTradeSides, selection } from "../lib/m15Maker.js";
import { kalshiMakerFee, kalshiTakerFee } from "../lib/fees.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

const C = Date.parse("2026-10-01T12:15:00Z");
const F = (x, bids, asks) => ({ k: "F", x, L: [bids, asks] });
const D = (x, sd, p, q) => ({ k: "D", x, sd, p, q });
const T = (x, side, yp, n) => ({ k: "T", x, side, yp, n });
const win = events => ({ ticker: "KXBTC15M-W", close: C, finalT: C - 120000, events });

// YES at 84/85: 100 resting on the 84 bid. 30 of it trades before our
// order lands, leaving 70 ahead of us.
const yesEvents = [
  F(C - 120000, [[0.84, 100], [0.83, 500]], [[0.85, 200], [0.86, 300]]),
  D(C - 89960, "b", 0.84, -30), T(C - 89950, "no", 0.84, 30),     // before landing (decision C-90000 + 100ms)
  T(C - 80000, "yes", 0.85, 50),                                   // a taker BUYING: never fills a bid
  T(C - 70000, "no", 0.84, 60),                                    // join: 70 -> 10 ahead; front: fills
  T(C - 60000, "no", 0.84, 15),                                    // join: 10 used, 5 fill
  T(C - 50000, "no", 0.83, 1),                                     // through 84: the rest fills
];
const yesDec = { t: C - 90000, secs: 90, side: "yes", qty: 10, priceMax: 0.95 };

console.log("join and front, YES");
{
  const j = simulateMaker(win(yesEvents), yesDec, { mode: "join" });
  ok(j.status === "ok" && j.limit === 0.84 && j.queueAhead === 70, "posts at the bid, behind the 70 still resting when it lands", JSON.stringify(j));
  ok(j.filled === 10 && j.firstFillSecs === 60, "fills 5 once the queue is used, the rest when a trade goes through", JSON.stringify(j));
  const f = simulateMaker(win(yesEvents), yesDec, { mode: "front" });
  ok(f.filled === 10 && f.firstFillSecs === 70, "front of the queue fills on the first sell at its price", JSON.stringify(f));
  const noThrough = simulateMaker(win(yesEvents.slice(0, -1)), yesDec, { mode: "join" });
  ok(noThrough.filled === 5, "without the trade-through, only what the queue let through", JSON.stringify(noThrough));
  // A taker BUYING at our price (the ask came down to 84 and was lifted)
  // is not a seller: it neither fills us nor moves the queue.
  const buyAt = [...yesEvents.slice(0, 3), T(C - 75000, "yes", 0.84, 100), ...yesEvents.slice(3, -1)];
  const ba = simulateMaker(win(buyAt), yesDec, { mode: "join" });
  ok(ba.filled === 5, "a taker buy printing at our bid price neither fills nor advances the queue", JSON.stringify(ba));
  const early = simulateMaker(win(yesEvents), { ...yesDec, t: C - 89990 }, { mode: "join", latencyMs: 100 });
  ok(early.queueAhead === 70, "latency: the book at landing decides the queue", JSON.stringify(early));
  const preLand = simulateMaker(win(yesEvents), { ...yesDec, t: C - 90000 }, { mode: "front", latencyMs: 0 });
  ok(preLand.queueAhead === 0 && preLand.filled === 10, "front with no latency", JSON.stringify(preLand));
}

console.log("NO, and improving the price");
{
  // YES 14/16: NO is bid at 84 (1 - 0.16), offered at 86 (1 - 0.14).
  const ev = [
    F(C - 120000, [[0.14, 100]], [[0.16, 40]]),
    T(C - 90000, "no", 0.14, 100),          // takers selling YES: never fills a NO bid
    T(C - 80000, "yes", 0.16, 30),          // join: 40 -> 10 ahead; improve (YES 0.15): through
    T(C - 70000, "yes", 0.16, 15),          // join: 10 used, 5 fill
    T(C - 60000, "yes", 0.17, 1),           // join: through
  ];
  const dec = { t: C - 100000, secs: 100, side: "no", qty: 10, priceMax: 0.95 };
  const j = simulateMaker(win(ev), dec, { mode: "join" });
  ok(j.limit === 0.84 && j.queueAhead === 40 && j.filled === 10 && j.firstFillSecs === 70, "NO joins at 1 - ask behind the YES offers there, filled by takers buying YES", JSON.stringify(j));
  const im = simulateMaker(win(ev), dec, { mode: "improve" });
  ok(im.improved && near(im.limit, 0.85) && im.queueAhead === 0 && im.filled === 10 && im.firstFillSecs === 80, "a 2c spread: improves to 85, alone, filled by the first YES buy through it", JSON.stringify(im));
  const narrow = simulateMaker(win(yesEvents), yesDec, { mode: "improve" });
  ok(!narrow.improved && narrow.limit === 0.84 && narrow.queueAhead === 70, "a 1c spread: cannot improve, so it JOINS behind the queue", JSON.stringify(narrow));
}

console.log("cutoff and fallback");
{
  const ev = [...yesEvents.slice(0, -1), T(C - 3000, "no", 0.83, 1)];   // the through-trade lands after the cutoff
  const j = simulateMaker(win(ev), yesDec, { mode: "join", cutoffSecs: 5 });
  ok(j.filled === 5 && j.takeQty === 0, "nothing fills after the cutoff, and no fallback unless asked", JSON.stringify(j));
  const fb = simulateMaker(win(ev), yesDec, { mode: "join", cutoffSecs: 5, fallback: true });
  ok(fb.filled === 5 && fb.takeQty === 5 && fb.takePrice === 0.85, "fallback buys the rest at the ask", JSON.stringify(fb));
  const band = simulateMaker(win(ev), { ...yesDec, priceMax: 0.84 }, { mode: "join", cutoffSecs: 5, fallback: true });
  ok(band.takeQty === 0, "but not above the rule's price band", JSON.stringify(band));
  const thin = simulateMaker(win([...ev.slice(0, 1), D(C - 6000, "a", 0.85, -197), ...ev.slice(1)]), yesDec, { mode: "join", cutoffSecs: 5, fallback: true });
  ok(thin.takeQty === 3, "and not more than rests at the ask", JSON.stringify(thin));
  ok(simulateMaker(win(yesEvents), { ...yesDec, t: C - 4000 }, { cutoffSecs: 5 }).status === "late", "a decision landing after the cutoff posts nothing");
  ok(simulateMaker(win(yesEvents), { ...yesDec, t: C - 125000 }, {}).status === "noBook", "before the final-window book exists: not replayable");
}

console.log("P&L and fees");
{
  const m = { ticker: "KXBTC15M-W", close: C, result: "yes" };
  const sim = simulateMaker(win(yesEvents), yesDec, { mode: "join" });
  const t = makerTrade(m, yesDec, sim, { mult: 1, feeType: "quadratic" });
  ok(near(t.pnl, 10 - 8.4) && t.entryFee === 0, "10 filled at 84, won, no maker fee: +$1.60", JSON.stringify(t));
  const lost = makerTrade({ ...m, result: "no" }, yesDec, sim, { mult: 1, feeType: "quadratic" });
  ok(near(lost.pnl, -8.4), "lost: -$8.40");
  const fb = simulateMaker(win([...yesEvents.slice(0, -1), T(C - 3000, "no", 0.83, 1)]), yesDec, { mode: "join", cutoffSecs: 5, fallback: true });
  const tf = makerTrade(m, yesDec, fb, { mult: 1, feeType: "quadratic" });
  ok(near(tf.pnl, 10 - (5 * 0.84 + 5 * 0.85 + kalshiTakerFee(0.85, 5, 1))) && tf.makerQty === 5 && tf.takerQty === 5, "half resting, half taken: the taker half pays the taker fee", JSON.stringify(tf));
  ok(makerTrade(m, yesDec, sim, { feeType: "flat" }) === null, "an unread fee schedule prices nothing");
  ok(kalshiMakerFee(0.5, 100, 1, "quadratic") === 0, "quadratic series: makers pay nothing");
  ok(kalshiMakerFee(0.5, 100, 1, "quadratic_with_maker_fees") === 0.44, "maker-fee series: 0.0175 x 100 x 0.25 = 0.4375 -> 0.44");
  ok(kalshiMakerFee(0.5, 100, 1, "quadratic_with_combo_maker_fees") === 0.88, "combo: 0.035 x 100 x 0.25 = 0.875 -> 0.88");
  ok(kalshiMakerFee(0.5, 100, 1, "flat") === null && kalshiMakerFee(0.5, 100, 1, undefined) === null, "flat or unknown: null, not zero");
}

console.log("the tape");
{
  const Tp = newTape(), wanted = new Map([["KXBTC15M-W", C]]);
  feedTape(Tp, { k: "final", t: C - 120000, m: "KXBTC15M-W", close: new Date(C).toISOString() }, wanted);
  feedTape(Tp, { k: "full", t: C - 120000, x: C - 120000, m: "KXBTC15M-W", L: [[[0.5, 1]], [[0.51, 1]]] }, wanted);
  feedTape(Tp, { k: "tr", t: C - 400000, x: C - 400000, m: "KXBTC15M-W", yp: 0.5, n: 1, side: "no" }, wanted);
  feedTape(Tp, { k: "tr", t: C - 30000, x: C - 30000, m: "KXBTC15M-W", yp: 0.5, n: 1, side: "no" }, wanted);
  feedTape(Tp, { k: "d", t: C - 20000, x: C - 20000, m: "KXGOLD15M-OTHER", sd: "b", p: 0.5, q: 1 }, wanted);
  const w = Tp.win.get("KXBTC15M-W");
  ok(w && w.events.length === 2 && Tp.win.size === 1, "keeps the final window's book and trades, drops earlier trades and unwanted tickers", JSON.stringify(w?.events));
  ok(disrupted(Tp, w) === null, "an uninterrupted window is replayable");
  feedTape(Tp, { k: "gap", t: C - 50000, m: ["KXBTC15M-W"] }, wanted);
  ok(disrupted(Tp, w) === "sequence gap", "a sequence gap in the final two minutes excludes it");
  const T2 = newTape();
  feedTape(T2, { k: "final", t: C - 120000, m: "KXBTC15M-W", close: new Date(C).toISOString() }, wanted);
  feedTape(T2, { k: "full", t: C - 120000, x: C - 120000, m: "KXBTC15M-W", L: [[], []] }, wanted);
  feedTape(T2, { k: "conn", t: C - 10000, ev: "close" }, wanted);
  ok(disrupted(T2, T2.win.get("KXBTC15M-W")) === "socket event", "so does a socket event");
}

console.log("trade sides and selection");
{
  const s = checkTradeSides(win(yesEvents));
  ok(s.total >= 4 && s.agree === s.total, "every recorded trade sits on the side its taker_side says", JSON.stringify(s));
  const flipped = yesEvents.map(e => e.k === "T" ? { ...e, side: e.side === "yes" ? "no" : "yes" } : e);
  const f = checkTradeSides(win(flipped));
  ok(f.agree === 0, "an inverted mapping agrees with none", JSON.stringify(f));
  const sel = selection([{ filled: 10, won: false }, { filled: 5, won: false }, { filled: 0, won: true }, { filled: 0, won: true }, { filled: 10, won: true }]);
  ok(sel.filled === 3 && near(sel.winFilled, 1 / 3) && sel.winUnfilled === 1, "win rate of filled against unfilled decisions", JSON.stringify(sel));
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
