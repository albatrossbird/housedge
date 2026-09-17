// How much money is actually on the table, not how good the first
// contract looks.
//
// The card has always reported an edge PER CONTRACT at the touch, and
// the touch is one number about the cheapest sliver of the book. A live
// NFL book measured 2026-09-17:
//
//   level  price   size   cumulative  avg px
//     1    0.49    1544       1544    0.4900   <- all the card showed
//     2    0.50    6559       8103    0.4981
//
// Five times the size for eight tenths of a cent worse on average. A
// reader told "+3.0c on 1,544" and a reader told "$177 across 8,103"
// are being shown the same market and will make different decisions,
// and the second one is the true description.
//
// WALKING DEEPER NEVER IMPROVES THE PRICE. The best ask is by
// definition the cheapest thing offered; every level behind it is
// worse, so edge per contract only falls with size. What rises is the
// TOTAL, and total is what a reader spends. Two effects make the
// trade-off worth taking:
//
//   1. A fat level one cent behind a thin touch barely moves the
//      average, as above.
//   2. Kalshi rounds its fee UP TO THE CENT PER ORDER, so the
//      per-contract fee FALLS with size — 2.00c on four contracts
//      against 1.75c on five hundred. That is a sign change on a
//      marginal pair, not a rounding detail: this repo has a recorded
//      case quoted at 99.979c over 100 contracts and 100.149c over the
//      four actually on offer.
//
// PROFIT IS NOT MONOTONIC IN SIZE, so it cannot be solved by taking
// everything. It rises while the marginal contract still clears its
// cost and falls after. Price is piecewise constant across a ladder, so
// the maximum always sits on a level boundary — evaluating every
// boundary is exact, and there are only tens of them.

import { kalshiTakerFee, polymarketTakerFee } from "./fees.js";

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Best-first, always sorted here rather than trusted from the source.
// Kalshi returns worst-first and Polymarket's CLOB puts the best price
// LAST; both have been observed, and a walker that trusts array order
// silently fills at the wrong end of the book.
export function sortOffers(levels) {
  return (levels || [])
    .map(l => (Array.isArray(l) ? { price: num(l[0]), size: num(l[1]) }
                                : { price: num(l?.price), size: num(l?.size) }))
    .filter(l => l.price != null && l.size != null && l.size > 0 && l.price > 0 && l.price < 1)
    .sort((a, b) => a.price - b.price);
}

// Kalshi's orderbook publishes two BID ladders, not a bid and an ask.
//
// To BUY YES you lift the NO bids: someone bidding p for NO is offering
// YES at 1 - p. Reading `yes_dollars` as the YES offers would quote the
// side nobody is selling, which is the most expensive kind of wrong —
// it looks like a book and prices a trade that cannot happen.
export function kalshiOffers(orderbook, side) {
  const ob = orderbook?.orderbook_fp || orderbook?.orderbook || orderbook || {};
  const from = side === "yes" ? (ob.no_dollars || ob.no)
                              : (ob.yes_dollars || ob.yes);
  return sortOffers((from || []).map(l => {
    const p = num(Array.isArray(l) ? l[0] : l?.price);
    const s = num(Array.isArray(l) ? l[1] : l?.size);
    return p == null ? null : { price: 1 - p, size: s };
  }).filter(Boolean));
}

// Spend to fill `contracts` from an offer ladder, with the levels used.
// A ladder that runs out reports what it COULD fill rather than
// pretending; the caller decides what to do with a partial.
export function walkOffers(offers, contracts) {
  let left = contracts, spend = 0;
  const used = [];
  for (const l of offers) {
    if (left <= 0) break;
    const take = Math.min(left, l.size);
    spend += take * l.price;
    used.push({ price: l.price, size: take });
    left -= take;
  }
  const filled = contracts - left;
  return { filled, spend, used, complete: left <= 0 };
}

export const ladderDepth = offers => offers.reduce((a, l) => a + l.size, 0);

// THE ROUNDING IS PER ORDER, so the raw fee is summed across the levels
// filled and rounded ONCE. Calling kalshiTakerFee per level would round
// each one up separately and charge a cent of phantom fee per level —
// on a ten-level fill that is ten cents of cost that does not exist,
// which would make deep fills look worse than shallow ones and invert
// the very comparison this module is for.
export function kalshiFeeOverLevels(used, feeMultiplier = 1) {
  const mult = Number.isFinite(Number(feeMultiplier)) ? Number(feeMultiplier) : 1;
  let raw = 0;
  for (const l of used) raw += l.size * 0.07 * mult * l.price * (1 - l.price);
  return Math.ceil(raw * 100) / 100;
}

export function polyFeeOverLevels(used, feeSchedule = null) {
  let f = 0;
  for (const l of used) f += polymarketTakerFee(l.price, l.size, feeSchedule);
  return f;
}

// Every size at which the marginal price changes on either ladder.
// The optimum can only sit here, because between two boundaries the
// marginal cost is constant and profit is linear in size.
function boundaries(a, b) {
  const cuts = new Set();
  let c = 0; for (const l of a) { c += l.size; cuts.add(Math.floor(c)); }
  c = 0; for (const l of b) { c += l.size; cuts.add(Math.floor(c)); }
  const cap = Math.floor(Math.min(ladderDepth(a), ladderDepth(b)));
  return [...cuts].filter(n => n >= 1 && n <= cap).sort((x, y) => x - y);
}

// The whole curve, and the size that pays the most.
//
// A matched pair settles at exactly $1 whichever way it resolves, so
// profit at size q is q - (what both legs cost) - (what both venues
// charge). Returned as a CURVE rather than one number because the
// shape is the finding: a reader deciding whether to take 8,000
// contracts wants to see where it stops being worth it.
export function profitCurve(legA, legB, { maxPoints = 40 } = {}) {
  const A = legA.offers, B = legB.offers;
  if (!A.length || !B.length) return null;

  const feeOf = (leg, used) => (leg.venue === "kalshi"
    ? kalshiFeeOverLevels(used, leg.feeMultiplier)
    : polyFeeOverLevels(used, leg.feeSchedule));

  const at = q => {
    const a = walkOffers(A, q), b = walkOffers(B, q);
    // A size neither ladder can fill is not a trade. Report nothing
    // rather than a profit on contracts that do not exist.
    if (!a.complete || !b.complete) return null;
    const cost = a.spend + b.spend + feeOf(legA, a.used) + feeOf(legB, b.used);
    return {
      contracts: q,
      costPerPair: cost / q,
      edgePerPair: 1 - cost / q,
      totalProfit: q - cost,
      fees: feeOf(legA, a.used) + feeOf(legB, b.used),
    };
  };

  const pts = boundaries(A, B).map(at).filter(Boolean);
  if (!pts.length) return null;

  let best = pts[0];
  for (const p of pts) if (p.totalProfit > best.totalProfit) best = p;

  // Thin the curve for transport, but never drop the point being
  // recommended — a curve whose own maximum is missing invites the
  // reader to check the arithmetic and find it wrong.
  let curve = pts;
  if (pts.length > maxPoints) {
    const step = Math.ceil(pts.length / maxPoints);
    curve = pts.filter((_, i) => i % step === 0);
    if (!curve.includes(best)) curve.push(best);
    curve.sort((x, y) => x.contracts - y.contracts);
  }

  return {
    best,
    curve,
    maxContracts: Math.floor(Math.min(ladderDepth(A), ladderDepth(B))),
    // What the card used to show, kept so the two can be compared
    // rather than the change being invisible.
    atTouch: pts[0].contracts === 1 ? pts[0] : at(1),
    levelsA: A.length,
    levelsB: B.length,
  };
}
