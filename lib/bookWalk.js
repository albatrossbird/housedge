// What an order of N contracts ACTUALLY fills at, level by level.
//
// The touch is one number and an order is not. A book showing "82c"
// might have 8 contracts there and the next 92 at 83c, so a 100-lot
// fills at an average of 82.92c — and the difference between quoting
// 82c and quoting 82.92c is the difference between an edge and a loss
// on a two-leg trade where the error is paid twice.
//
// This is the generalisation of a lesson already recorded here: the
// same Bitcoin strike family offered 7 contracts at one price and 710
// at another, six cents of profit against fifteen dollars. An edge
// without a size is not a finding, and a size without the LADDER is
// still only the first level of one.
//
// We already hold the ladders — fetchClobBooks returns full bids/asks
// arrays and touchOf keeps only the best level.

const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// ORDER IS NOT ASSUMED. Polymarket's CLOB returns asks with the BEST
// price LAST, which is the opposite of the obvious reading and is
// already a documented trap in this repo. Sorting explicitly means a
// venue changing its convention costs nothing, where trusting the
// array order would silently fill at the WORST price and report it as
// the best.
export function sortLevels(levels, side) {
  const out = [];
  for (const l of Array.isArray(levels) ? levels : []) {
    const price = num(l?.price), size = num(l?.size);
    // A level with no size is not a level. Number(null) is 0 and a
    // fabricated zero would silently consume nothing while counting as
    // a price step.
    if (price == null || size == null || size <= 0) continue;
    if (price <= 0 || price >= 1) continue;
    out.push({ price, size });
  }
  // Buying: cheapest ask first. Selling: highest bid first.
  out.sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));
  return out;
}

// Walk the ladder for `contracts`, returning what each level
// contributes and what the whole order averages.
//
// A PARTIAL FILL IS REPORTED, NEVER AVERAGED AWAY. If the book holds
// 40 against an order of 100, the answer is "40 at 82.4c and 60
// unfillable" — not "82.4c", which would read as a completed order at
// a good price. That distinction is the entire point of the exercise.
export function walkBook(levels, contracts, side = "buy") {
  const want = Math.max(Math.floor(num(contracts) ?? 0), 0);
  const book = sortLevels(levels, side);
  const fills = [];
  let filled = 0, cost = 0;

  for (const lvl of book) {
    if (filled >= want) break;
    const take = Math.min(lvl.size, want - filled);
    fills.push({ price: lvl.price, size: take, cumulative: filled + take });
    filled += take;
    cost += take * lvl.price;
  }

  const best = book.length ? book[0].price : null;
  const avgPrice = filled > 0 ? cost / filled : null;
  return {
    fills,
    filled,
    requested: want,
    shortfall: want - filled,
    complete: filled === want && want > 0,
    best,
    avgPrice,
    // Slippage is signed by DIRECTION: buying worse means paying more,
    // selling worse means receiving less. Reported as a positive cost
    // either way so it never reads as a gain.
    slippage: avgPrice == null || best == null ? null
      : (side === "buy" ? avgPrice - best : best - avgPrice),
    // Total depth available on this side, which is the honest cap on
    // any position size.
    available: book.reduce((s, l) => s + l.size, 0),
  };
}

// The largest order that fills without moving past `maxPrice`.
// Useful the other way round: not "what does 100 cost" but "how much
// can I take before this stops being worth taking".
export function sizeAtOrBetter(levels, maxPrice, side = "buy") {
  const limit = num(maxPrice);
  if (limit == null) return 0;
  return sortLevels(levels, side)
    .filter(l => (side === "buy" ? l.price <= limit : l.price >= limit))
    .reduce((s, l) => s + l.size, 0);
}
