// lib/m15Venues.js — the 15-minute Bitcoin market on Kalshi and
// Polymarket US. Hand-built lines, numbers worked by hand.
//
// Pinned here:
//   1. A .us book becomes the engine's row: touch, depth within 1c
//      (touch inclusive), the .us exchange's clock. Lines without that
//      clock, one-sided or crossed books are dropped.
//   2. Rows collapse to the last book in each second.
//   3. Intents map to the taker buying or selling Up; SHORT trade prices
//      are carried both ways and resolved per run.
//   4. .us fees: the taker fee as lib/venueCompare.js rounds it, and the
//      maker rebate as a NEGATIVE fee.
//   5. Best of both buys from the cheaper venue all-in first, spills to
//      the other at its depth, respects the price cap and a stale .us book.
//   6. The resting-order replay runs on the .us tape, and the trade-side
//      check picks the reading of SHORT prices that agrees with the book.
import { pmusRow, secondly, usTakerSide, pmusFee, pmusMakerFee, bestOfBoth, legsTrade, newUsTape, feedUsTape, resolveUsWindow } from "../lib/m15Venues.js";
import { pmusTakerFee } from "../lib/venueCompare.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { simulateMaker, checkTradeSides, makerTrade, disrupted } from "../lib/m15Maker.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const C = Date.parse("2026-10-02T12:15:00Z");

console.log(".us books as rows");
{
  const r = pmusRow({ k: "pb", t: C - 30100, x: C - 30000, m: "s", b: [[0.86, 100], [0.85, 50], [0.80, 999]], a: [[0.88, 40], [0.89, 60], [0.95, 999]] }, C);
  ok(r && r.t === C - 30000 && r.secs === 30 && r.bid === 0.86 && r.ask === 0.88, "touch, timed on the .us exchange's clock", JSON.stringify(r));
  ok(r.bidD1 === 150 && r.askD1 === 100, "depth within 1c of the touch, touch inclusive", JSON.stringify(r));
  ok(pmusRow({ k: "pb", t: C, m: "s", b: [[0.5, 1]], a: [[0.51, 1]] }, C) === null, "no exchange timestamp: dropped, not timed on receipt");
  ok(pmusRow({ k: "pb", x: C, m: "s", b: [], a: [[0.51, 1]] }, C) === null, "a one-sided book has no touch");
  ok(pmusRow({ k: "pb", x: C, m: "s", b: [[0.52, 1]], a: [[0.51, 1]] }, C) === null, "a crossed book is not quotable");
  const rows = secondly([{ t: 1000 }, { t: 1500 }, { t: 1999 }, { t: 2001 }].map(x => ({ ...x })));
  ok(rows.length === 2 && rows[0].t === 1999 && rows[1].t === 2001, "the last book in each second", JSON.stringify(rows));
}

console.log("fees and sides");
{
  ok(pmusFee(0.85, 10) === pmusTakerFee(0.85, 10) && pmusFee(0.5, 100) === 1.74, ".us taker fee: 0.0695 x 100 x 0.25 = 1.7375 -> 1.74");
  ok(pmusMakerFee(0.5, 100) === -0.31, ".us maker REBATE: 0.0125 x 100 x 0.25 = 0.3125 -> paid 0.31", String(pmusMakerFee(0.5, 100)));
  ok(pmusMakerFee(0.5, 0) === 0 && pmusMakerFee(1, 10) === 0, "no rebate on nothing");
  ok(usTakerSide("ORDER_INTENT_BUY_LONG") === "yes" && usTakerSide("ORDER_INTENT_SELL_SHORT") === "yes", "buying Up or selling Down takes Up offers");
  ok(usTakerSide("ORDER_INTENT_SELL_LONG") === "no" && usTakerSide("ORDER_INTENT_BUY_SHORT") === "no", "selling Up or buying Down hits Up bids");
  ok(usTakerSide("ORDER_INTENT_UNKNOWN") === null && usTakerSide(null) === null, "anything else is not read as a side");
}

console.log("best of both");
{
  const kRow = { t: C - 30000, secs: 30, bid: 0.86, ask: 0.88, bidD1: 500, askD1: 6 };
  const uRows = [{ t: C - 31000, secs: 31, bid: 0.86, ask: 0.87, bidD1: 400, askD1: 4 }];
  const kFee = (p, n) => kalshiTakerFee(p, n, 1);
  const r = bestOfBoth({ side: "yes", t: C - 30000, size: 10, priceMax: 0.95, kRow, uRows, kFee, uFee: pmusFee });
  ok(r.legs.length === 2 && r.legs[0].venue === "polyus" && r.legs[0].qty === 4 && r.legs[1].venue === "kalshi" && r.legs[1].qty === 6,
    ".us cheaper (87c): its 4 first, the other 6 on Kalshi at 88c", JSON.stringify(r.legs));
  const m = { ticker: "T", close: C, result: "yes" };
  const t = legsTrade(m, "yes", C - 30000, 30, r.legs);
  ok(t.qty === 10 && near(t.entry, (4 * 0.87 + 6 * 0.88) / 10) && near(t.pnl, 10 - 4 * 0.87 - 6 * 0.88 - pmusFee(0.87, 4) - kFee(0.88, 6)),
    "one trade: average price, both venues' fees", JSON.stringify(t));
  const capped = bestOfBoth({ side: "yes", t: C - 30000, size: 10, priceMax: 0.875, kRow, uRows, kFee, uFee: pmusFee });
  ok(capped.legs.length === 1 && capped.legs[0].venue === "polyus" && capped.legs[0].qty === 4, "Kalshi's 88c is above the rule's cap: only .us fills", JSON.stringify(capped.legs));
  const stale = bestOfBoth({ side: "yes", t: C - 25000, size: 10, priceMax: 0.95, kRow, uRows, kFee, uFee: pmusFee });
  ok(stale.legs.every(l => l.venue === "kalshi"), "a .us book six seconds old is not that second's price", JSON.stringify(stale.legs));
  const no = bestOfBoth({ side: "no", t: C - 30000, size: 10, priceMax: 0.95, kRow: { ...kRow, bid: 0.10, ask: 0.11, bidD1: 500 }, uRows: [{ ...uRows[0], bid: 0.12, ask: 0.13, bidD1: 400 }], kFee, uFee: pmusFee });
  ok(no.legs[0].venue === "polyus" && near(no.legs[0].price, 0.88), "NO is bought at 1 - Up bid: .us's 12c bid sells Down at 88c, cheaper than Kalshi's 90c", JSON.stringify(no.legs));
}

console.log("resting orders on the .us tape");
{
  // Up 84/85 on .us, 100 resting on the 84 bid. Down-buyers (BUY_SHORT)
  // sell Up into it. Their price is printed as DOWN's (0.16) here, so the
  // "long" reading puts the trades nowhere near the book and "short" puts
  // them exactly on the bid.
  const slug = "cpc-btc-updown-15m-2026-10-02-1200z";
  const wanted = new Map([[slug, { ticker: "KXBTC15M-W", close: C }]]);
  const T = newUsTape();
  feedUsTape(T, { k: "pb", t: C - 120000, x: C - 120000, m: slug, b: [[0.84, 100]], a: [[0.85, 200]] }, wanted);
  feedUsTape(T, { k: "tr", t: C - 70000, x: C - 70000, m: slug, p: 0.16, q: 60, intent: "ORDER_INTENT_BUY_SHORT" }, wanted);
  feedUsTape(T, { k: "tr", t: C - 60000, x: C - 60000, m: slug, p: 0.16, q: 60, intent: "ORDER_INTENT_BUY_SHORT" }, wanted);
  feedUsTape(T, { k: "tr", t: C - 55000, x: C - 55000, m: slug, p: 0.85, q: 5, intent: "ORDER_INTENT_BUY_LONG" }, wanted);
  feedUsTape(T, { k: "pb", t: C - 900000, x: C - 900000, m: slug, b: [[0.5, 1]], a: [[0.51, 1]] }, wanted);
  const w = T.win.get("KXBTC15M-W");
  ok(w && w.events.length === 4 && disrupted(T, w) === null, "keeps the window's books and trades, drops a book from long before", JSON.stringify(w?.events?.map(e => e.k)));
  const asLong = resolveUsWindow(w, "long"), asShort = resolveUsWindow(w, "short");
  const cl = checkTradeSides(asLong), cs = checkTradeSides(asShort);
  ok(cs.agree === cs.total && cs.total === 3 && cl.agree < cl.total, "the trade-side check prefers the reading that puts trades on the book", JSON.stringify({ cl, cs }));
  const dec = { t: C - 90000, secs: 90, side: "yes", qty: 10, priceMax: 0.95 };
  const sim = simulateMaker(asShort, dec, { mode: "join" });
  ok(sim.status === "ok" && sim.queueAhead === 100 && sim.filled === 10, "join behind 100: 60 + 60 sold into the bid fills 10", JSON.stringify(sim));
  const t = makerTrade({ ticker: "KXBTC15M-W", close: C, result: "yes" }, dec, sim, { makerFee: pmusMakerFee, takerFee: pmusFee });
  ok(near(t.pnl, 10 - 8.4 - pmusMakerFee(0.84, 10)) && t.pnl > 1.6, "and the .us rebate is added to the P&L", JSON.stringify(t));
  T.conn.push(C - 50000);
  ok(disrupted(T, w) === "socket event", "a .us socket event in the final two minutes excludes the window");
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
