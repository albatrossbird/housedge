// bookDepth: what sits behind the touch on a 15-minute market.
//
// The fixture is the live KXBTC15M book probed on 2026-09-26, top five
// levels each side, IN THE ORDER KALSHI SENDS THEM — ascending, best
// last. Hand-shaped fixtures are how the size-key bug survived for
// weeks: that one was written to match the code instead of the API.

import { bookDepth } from "../lib/m15.js";

let failed = 0;
const eq = (got, want, what) => {
  const ok = Object.is(got, want) || (typeof got === "number" && typeof want === "number" && Math.abs(got - want) < 1e-9);
  if (ok) console.log(`  ok  ${what}`);
  else { failed++; console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const LIVE = { orderbook_fp: {
  yes_dollars: [["0.3400","1051.00"],["0.3500","1182.00"],["0.3600","1512.71"],["0.3700","1644.60"],["0.3800","4981.98"]],
  no_dollars:  [["0.5700","1245.60"],["0.5800","1123.30"],["0.5900","1001.00"],["0.6000","1094.00"],["0.6100","291.65"]],
}};

console.log("the touch, from a book that is sorted best-LAST");
{
  const d = bookDepth(LIVE);
  eq(d.book_bid, 0.38, "best YES bid is the highest yes_dollars level, not the first");
  // Kalshi publishes NO bids, not YES asks. A NO bid at 0.61 is a YES
  // offer at 0.39. Reading no_dollars as asks directly would put the
  // offer at 0.61 — on the wrong side of the bid.
  eq(d.book_ask, 0.39, "best YES ask is 1 - best NO bid");
  eq(d.book_ask > d.book_bid, true, "and so the book is not crossed");
}

console.log("\ncumulative depth, touch inclusive");
{
  const d = bookDepth(LIVE);
  eq(d.bid_depth_1c, 4981.98 + 1644.60, "1c = the touch plus the level one cent behind it");
  eq(d.bid_depth_3c, 4981.98 + 1644.60 + 1512.71 + 1182.00, "3c = four levels");
  eq(d.bid_depth_5c, 4981.98 + 1644.60 + 1512.71 + 1182.00 + 1051.00, "5c = all five here");
  eq(d.ask_depth_1c, 291.65 + 1094.00, "ask side measured from the NO stack, mirrored");
  eq(d.ask_depth_5c, 291.65 + 1094.00 + 1001.00 + 1123.30 + 1245.60, "ask 5c");
  // The imbalance a strategy would read: ~4.8x more resting on the bid
  // than the offer within a cent. That asymmetry is invisible in price.
  eq(Math.round(d.bid_depth_1c / d.ask_depth_1c * 10) / 10, 4.8, "bid-heavy by ~4.8x at 1c");
}

console.log("\nsub-cent ticks do not fall off a window's edge");
{
  // 0.380 - 0.370 in floats is 0.010000000000000009, which is > 0.01 and
  // would exclude the level exactly one cent away. Integer tenths of a
  // cent make the boundary exact.
  const d = bookDepth({ orderbook_fp: {
    yes_dollars: [["0.3700","10"],["0.3750","20"],["0.3800","30"]],
    no_dollars: [],
  }});
  eq(d.bid_depth_1c, 60, "a level exactly 1c behind is inside the 1c window");
  const d2 = bookDepth({ orderbook_fp: { yes_dollars: [["0.3690","10"],["0.3800","30"]], no_dollars: [] } });
  eq(d2.bid_depth_1c, 30, "a level 1.1c behind is outside it");
}

console.log("\nnull and zero mean different things");
{
  const empty = bookDepth({ orderbook_fp: { yes_dollars: [["0.4000","100"]], no_dollars: [] } });
  eq(empty.book_ask, null, "fetched, nobody offering: no ask price exists");
  eq(empty.ask_depth_1c, 0, "...and depth there is a TRUE zero, a fact about the book");
  eq(empty.bid_depth_1c, 100, "the other side is unaffected");

  const missing = bookDepth(null);
  eq(missing.book_bid, null, "book not fetched: no price");
  eq(missing.bid_depth_1c, null, "...and depth is NULL — unknown — never a coerced zero");
  eq(missing.ask_depth_5c, null, "every field, both sides");

  eq(bookDepth({}).bid_depth_3c, null, "a response with no orderbook key is not-fetched, not empty");
}

console.log("\nzero-size and malformed levels are ignored, not counted");
{
  const d = bookDepth({ orderbook_fp: {
    yes_dollars: [["0.5000","0"],["0.4900","50"],["bad","10"],["0.4800",null]],
    no_dollars: [["0.4500","25"]],
  }});
  eq(d.book_bid, 0.49, "a zero-size level is not the touch");
  eq(d.bid_depth_1c, 50, "and contributes nothing");
}

console.log("\nthe unsuffixed key is read too");
{
  const d = bookDepth({ orderbook: { yes_dollars: [["0.2000","7"]], no_dollars: [["0.7500","3"]] } });
  eq(d.book_bid, 0.2, "`orderbook` without _fp still parses");
  eq(d.book_ask, 0.25, "and mirrors");
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log("\nall passed");
