// A book that spans most of the probability range is not a quote, and
// its midpoint is not a price.
//
// realBook() already empties a LITERAL 0/1 book. A book of 0.07/0.92 is
// one tick away and has the identical problem, and it reached the page:
// 92 displayed legs carried a book over 80 points wide and every one
// rendered as "POLY GLOBAL 50%".
//
// Run: node scripts/wide-book.test.mjs

import { midpointIsMeaningful, WIDE_BOOK_PTS, realBook, tradeableArb } from "../lib/fees.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nthe threshold is where the measurement put it");
{
  // Across 780 displayed legs the widest book belonging to a market
  // with ANY recorded volume was 34.0pt. Every leg wider than that had
  // never traded. 40 sits in the gap with a margin rather than on the
  // edge of the observed data — so a real book at 34 must survive.
  check("40pt", WIDE_BOOK_PTS === 40, String(WIDE_BOOK_PTS));
  check("the widest OBSERVED traded book (34pt) still counts", midpointIsMeaningful(0.30, 0.64) === true);
  check("a 39.9pt book still counts", midpointIsMeaningful(0.30, 0.699) === true);
  check("a 40pt book does not", midpointIsMeaningful(0.30, 0.70) === false);
}

console.log("\nthe real case, from live polymarket.com data");
{
  // cfb-coast-del-2026-09-19: never traded, volumeNum null,
  // lastTradePrice null, outcomePrices ["0.495","0.505"].
  check("bid 0.07 / ask 0.92 is not a price", midpointIsMeaningful(0.07, 0.92) === false);
  check("bid 0.04 / ask 0.98 is not a price", midpointIsMeaningful(0.04, 0.98) === false);
  // A normal sports book on a traded market.
  check("bid 0.545 / ask 0.555 is a price", midpointIsMeaningful(0.545, 0.555) === true);
}

console.log("\nunreadable input is false, never a guess");
{
  check("no bid", midpointIsMeaningful(null, 0.9) === false);
  check("no ask", midpointIsMeaningful(0.1, null) === false);
  check("both absent", midpointIsMeaningful(null, null) === false);
  // Number(null) is 0, so a missing bid must not read as a 90pt book
  // OR as a valid 0-priced one; false covers both.
  check("crossed book", midpointIsMeaningful(0.9, 0.1) === false);
  check("zero-width book is fine", midpointIsMeaningful(0.5, 0.5) === true);
}

console.log("\nTHE EXECUTABLE PRICE IS UNTOUCHED");
{
  // An ask of 0.92 is real and takeable however wide the book is.
  // Emptying it would discard a genuine quote and UNDERSTATE what a
  // leg costs — the opposite of the error being fixed. realBook only
  // empties the literal 0/1 case, and that must stay true.
  const wide = realBook(0.07, 0.92);
  check("realBook keeps a wide two-sided book", wide.bid === 0.07 && wide.ask === 0.92,
        JSON.stringify(wide));
  const empty = realBook(0, 1);
  check("realBook still empties a literal 0/1 book", empty.bid == null && empty.ask == null,
        JSON.stringify(empty));

  // And the arb maths still prices through a wide book rather than
  // treating it as absent.
  const r = tradeableArb(
    { yesAsk: 0.40, noAsk: 0.40, yesAskSize: 100, yesBidSize: 100, feeMultiplier: 1 },
    { yesAsk: 0.92, noAsk: 0.07, yesAskSize: 100, yesBidSize: 100, feeSchedule: null },
  );
  check("a wide-book leg is still priced", r != null && r.r != null);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
