import { sortOffers, kalshiOffers, walkOffers, ladderDepth,
         kalshiFeeOverLevels, profitCurve } from "../lib/depthLadder.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

console.log("array order is never trusted");
{
  // Kalshi returns worst-first; Polymarket's CLOB puts the best LAST.
  // Both are real and a walker that trusts order fills at the wrong
  // end of the book.
  const s = sortOffers([["0.55", "5"], ["0.49", "100"], ["0.52", "20"]]);
  check("sorted cheapest first", s[0].price === 0.49 && s[2].price === 0.55);
  check("zero-size levels dropped", sortOffers([["0.5", "0"]]).length === 0);
  check("prices outside (0,1) dropped",
        sortOffers([["0", "9"], ["1", "9"], ["1.4", "9"]]).length === 0);
  check("junk dropped, not coerced to zero", sortOffers([[null, "5"], ["0.5", null]]).length === 0);
}

console.log("\nto BUY YES you lift the NO bids");
{
  // Kalshi publishes two BID ladders, not a bid and an ask. Reading
  // yes_dollars as the YES offers quotes the side nobody is selling.
  const ob = { orderbook_fp: {
    yes_dollars: [["0.44", "129"], ["0.47", "564"]],
    no_dollars:  [["0.48", "251"], ["0.50", "5000"]],
  }};
  const yes = kalshiOffers(ob, "yes");
  check("best YES offer is 1 - best NO bid", near(yes[0].price, 0.50));
  check("...carrying that level's size", yes[0].size === 5000);
  check("next YES offer is a cent worse", near(yes[1].price, 0.52));
  const no = kalshiOffers(ob, "no");
  check("best NO offer is 1 - best YES bid", near(no[0].price, 0.53));
  check("an empty book yields no offers", kalshiOffers({ orderbook_fp: {} }, "yes").length === 0);
}

console.log("\na partial fill is reported, never averaged away");
{
  const offers = sortOffers([["0.49", "10"], ["0.50", "10"]]);
  const w = walkOffers(offers, 15);
  check("filled 15", w.filled === 15 && w.complete);
  check("spend is 10x0.49 + 5x0.50", near(w.spend, 10 * 0.49 + 5 * 0.50));
  const over = walkOffers(offers, 100);
  check("asking beyond the book is INCOMPLETE", over.complete === false);
  check("...and reports what it could fill", over.filled === 20);
  check("depth is the sum of the ladder", ladderDepth(offers) === 20);
}

console.log("\nthe cent rounding is per ORDER, not per level");
{
  // Rounding each level separately invents a cent of fee per level. On
  // a ten-level fill that is ten cents that do not exist, and it would
  // make deep fills look worse than shallow ones — inverting the exact
  // comparison this module exists to make.
  const used = Array.from({ length: 10 }, (_, i) => ({ price: 0.50, size: 1 }));
  const once = kalshiFeeOverLevels(used, 1);
  const perLevel = used.reduce((a, l) => a + Math.ceil(l.size * 0.07 * l.price * (1 - l.price) * 100) / 100, 0);
  check(`summed then rounded once = $${once.toFixed(2)}`, near(once, 0.18));
  check(`rounded per level would be $${perLevel.toFixed(2)} — 10 phantom cents`, perLevel > once);
  check(`the phantom is $${(perLevel - once).toFixed(2)} on ten levels`, near(perLevel - once, 0.02, 1e-9));
  // It scales with the number of levels, which is what makes it
  // dangerous here: the deeper the fill, the more phantom fee, so the
  // wrong model penalises exactly the trades this module recommends.
  const deep = Array.from({ length: 40 }, () => ({ price: 0.50, size: 1 }));
  const deepOnce = kalshiFeeOverLevels(deep, 1);
  const deepPer = deep.reduce((a, l) => a + Math.ceil(l.size * 0.07 * l.price * (1 - l.price) * 100) / 100, 0);
  check(`at 40 levels the phantom grows to $${(deepPer - deepOnce).toFixed(2)}`,
        deepPer - deepOnce > perLevel - once);
}

console.log("\nprofit is not monotonic, so the max is found not assumed");
{
  // Cheap size first, then a level that costs more than it returns.
  const legA = { venue: "kalshi", feeMultiplier: 1,
                 offers: sortOffers([["0.40", "100"], ["0.58", "900"]]) };
  const legB = { venue: "poly", feeSchedule: null,
                 offers: sortOffers([["0.50", "1000"]]) };
  const r = profitCurve(legA, legB);
  check("a maximum exists", r && r.best);
  check(`it is at 100 contracts, not 1000 (got ${r.best.contracts})`, r.best.contracts === 100);
  check("taking everything would pay less",
        r.curve.find(p => p.contracts === 1000).totalProfit < r.best.totalProfit);
  check("edge per contract is POSITIVE at the max", r.best.edgePerPair > 0);
}

console.log("\nthe headline number is total dollars, and it beats the touch");
{
  // The live NFL shape: a thin touch with a fat level one cent behind.
  const legA = { venue: "kalshi", feeMultiplier: 1,
                 offers: sortOffers([["0.49", "1544"], ["0.50", "6559"]]) };
  const legB = { venue: "poly", feeSchedule: null,
                 offers: sortOffers([["0.45", "50000"]]) };
  const r = profitCurve(legA, legB);
  check(`best size is the deep level (${r.best.contracts})`, r.best.contracts === 8103);
  check("total profit far exceeds the touch-only trade",
        r.best.totalProfit > r.curve[0].totalProfit * 3);
  check("per-contract edge is LOWER there than at the touch",
        r.best.edgePerPair < r.curve[0].edgePerPair);
  check("...which is the whole point: worse rate, much more money",
        r.best.totalProfit > r.curve[0].totalProfit);
}

console.log("\nthe touch figure is priced by the SAME function as the best");
{
  // A live shape where the two calculators disagreed: the touch level
  // is fillable and profitable, and a deeper level pays more in total.
  const legA = { venue: "kalshi", feeMultiplier: 1,
                 offers: sortOffers([["0.49", "134"], ["0.50", "1312"]]) };
  const legB = { venue: "poly", feeSchedule: null,
                 offers: sortOffers([["0.45", "50000"]]) };
  const r = profitCurve(legA, legB);
  check("atTouch exists", r && r.atTouch);
  // The bug this pins: atTouch used to be at(1) — the profit on ONE
  // contract — which is a rate, not a total, and is not comparable
  // with best.totalProfit at all. Two legs rendered a "best" a cent
  // below the "touch" it was shown beside.
  check(`atTouch is the whole touch level, not one contract (${r.atTouch.contracts})`,
        r.atTouch.contracts === 134);
  check("it is the curve's first point, so both come from one calculator",
        r.atTouch.contracts === r.curve[0].contracts &&
        near(r.atTouch.totalProfit, r.curve[0].totalProfit, 1e-12));
  // The comparison the card makes must be well-founded in both
  // directions: the best is never below the touch, because the touch
  // is one of the points the maximum is taken over.
  check("the best is never worse than the touch",
        r.best.totalProfit >= r.atTouch.totalProfit - 1e-12);
}

console.log("\na size neither ladder can fill is not a trade");
{
  const legA = { venue: "kalshi", feeMultiplier: 1, offers: sortOffers([["0.40", "10"]]) };
  const legB = { venue: "poly", feeSchedule: null, offers: sortOffers([["0.50", "99999"]]) };
  const r = profitCurve(legA, legB);
  check("capped by the THINNER ladder", r.maxContracts === 10);
  check("no point beyond it", r.curve.every(p => p.contracts <= 10));
  check("an empty ladder returns null",
        profitCurve({ venue: "kalshi", offers: [] }, legB) === null);
}

console.log("\nthe thinned curve still contains its own maximum");
{
  const many = Array.from({ length: 300 }, (_, i) =>
    [String((0.30 + i * 0.001).toFixed(3)), "10"]);
  const legA = { venue: "kalshi", feeMultiplier: 1, offers: sortOffers(many) };
  const legB = { venue: "poly", feeSchedule: null, offers: sortOffers([["0.40", "99999"]]) };
  const r = profitCurve(legA, legB, { maxPoints: 20 });
  check("curve is thinned", r.curve.length <= 21);
  check("but the recommended point is in it",
        r.curve.some(p => p.contracts === r.best.contracts));
  check("and the curve stays in size order",
        r.curve.every((p, i, a) => i === 0 || a[i - 1].contracts < p.contracts));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
