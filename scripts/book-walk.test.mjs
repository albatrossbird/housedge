import { sortLevels, walkBook, sizeAtOrBetter } from "../lib/bookWalk.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// Polymarket's CLOB returns asks with the BEST price LAST.
const asks = [{ price: 0.86, size: 500 }, { price: 0.84, size: 12 }, { price: 0.83, size: 150 }, { price: 0.82, size: 8 }];
const bids = [{ price: 0.75, size: 900 }, { price: 0.78, size: 300 }, { price: 0.79, size: 44 }];

console.log("array order is never trusted");
{
  const s = sortLevels(asks, "buy");
  check("buying sorts cheapest first regardless of input order", s[0].price === 0.82 && s[3].price === 0.86);
  const b = sortLevels(bids, "sell");
  check("selling sorts highest first", b[0].price === 0.79 && b[2].price === 0.75);
  // Number(null) is 0: a zero-size level would consume nothing while
  // still counting as a price step.
  check("a zero-size level is dropped", sortLevels([{ price: 0.8, size: 0 }], "buy").length === 0);
  check("a null size is dropped", sortLevels([{ price: 0.8, size: null }], "buy").length === 0);
  check("a price outside (0,1) is dropped", sortLevels([{ price: 1, size: 5 }, { price: 0, size: 5 }], "buy").length === 0);
}

console.log("\nwalking the ladder");
{
  const r = walkBook(asks, 100, "buy");
  check("it eats levels in price order", r.fills[0].price === 0.82 && r.fills[1].price === 0.83);
  check("first level gives only its 8", r.fills[0].size === 8);
  check("the rest comes from 0.83", r.fills[1].size === 92);
  check("all 100 filled", r.filled === 100 && r.complete);
  // 8*0.82 + 92*0.83 = 6.56 + 76.36 = 82.92 over 100
  check("average is 0.8292, not the 0.82 touch", near(r.avgPrice, 0.8292));
  check("best is still reported as 0.82", r.best === 0.82);
  check("slippage is +0.92c", near(r.slippage, 0.0092));
  check("cumulative is tracked per level", r.fills[1].cumulative === 100);
}

console.log("\na partial fill is REPORTED, never averaged away");
{
  // The whole point: "40 at a good price" must not read as a completed
  // order. An edge without a size is not a finding.
  const thin = [{ price: 0.82, size: 8 }, { price: 0.83, size: 32 }];
  const r = walkBook(thin, 100, "buy");
  check("only what exists is filled", r.filled === 40);
  check("complete is FALSE", r.complete === false);
  check("the shortfall is named", r.shortfall === 60);
  check("available says how deep the book really is", r.available === 40);
  check("the average covers only the filled part", near(r.avgPrice, (8 * 0.82 + 32 * 0.83) / 40));

  const empty = walkBook([], 100, "buy");
  check("an empty book fills nothing and averages null", empty.filled === 0 && empty.avgPrice === null);
  check("...and does not claim completion", empty.complete === false);
}

console.log("\nselling walks the bids, and slippage still reads as a cost");
{
  const r = walkBook(bids, 100, "sell");
  check("best bid first", r.fills[0].price === 0.79);
  check("44 then 56 from 0.78", r.fills[0].size === 44 && r.fills[1].size === 56);
  check("average is below the best bid", r.avgPrice < 0.79);
  // Selling worse means RECEIVING less; reported positive so it never
  // reads as a gain.
  check("slippage is positive, not negative", r.slippage > 0);
  check("and equals best minus average", near(r.slippage, 0.79 - r.avgPrice));
}

console.log("\nhow much can I take before it stops being worth it");
{
  check("everything at or under 0.83", sizeAtOrBetter(asks, 0.83, "buy") === 158);
  check("only the touch at 0.82", sizeAtOrBetter(asks, 0.82, "buy") === 8);
  check("nothing below the book", sizeAtOrBetter(asks, 0.5, "buy") === 0);
  check("selling counts bids at or above", sizeAtOrBetter(bids, 0.78, "sell") === 344);
  check("a null limit is 0, not everything", sizeAtOrBetter(asks, null, "buy") === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
