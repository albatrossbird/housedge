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
export function profitCurve(legA, legB, { maxPoints = 250 } = {}) {
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
  //
  // THE CAP IS HIGH ON PURPOSE. Every point here is a real level
  // boundary, and between two adjacent boundaries the marginal price is
  // constant, so profit is exactly LINEAR — which is what lets the
  // card's calculator interpolate a typed size and be right rather than
  // close. Drop a boundary and that guarantee goes with it: the chord
  // between the survivors cuts the corner the missing level made, and
  // the number quoted is one nobody can fill at.
  //
  // Measured on live data at the old cap of 40: one leg of 34 was
  // thinned at all, median 25 points, and every curve on the response
  // cost 36KB of 1.44MB. Paying a few more KB to keep the arithmetic
  // exact is the trade this whole module exists to make.
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
    // The money available at the best price on each side — the thing
    // the deeper fill is being compared AGAINST, so it is priced by
    // this same function over this same ladder. It used to be at(1),
    // the profit on a single contract, which is a RATE and not
    // comparable with a dollar total at all.
    atTouch: pts[0],
    levelsA: A.length,
    levelsB: B.length,
  };
}

// WHICH SIDE OF A POLYMARKET US MARKET IS THIS BOOK?
//
// `/book` takes a market slug and returns bids and offers without
// saying which outcome they quote. This venue's outcomes/outcomePrices
// are documented as misaligned, so a convention inferred from one
// market would eventually price the wrong half of a game — the failure
// that renders a large fake arbitrage and the one this codebase has
// paid for more than once.
//
// So it is PROVEN per market instead. The leg already carries a touch
// we trust, priced from `marketSides`. If the book's touch is that
// touch, the book quotes this leg's side. If it is the complement, the
// book quotes the other side and is mirrored. If it is neither, the
// market moved between reads or the mapping is wrong, and skipping is
// the only safe answer — a ladder for the wrong outcome is worse than
// no ladder, because it is confident.
//
// `wantYes` is whether we are BUYING this leg's yes. Buying its no is
// the complement of its bids: selling yes at the bid is buying no.
export const US_TOUCH_EPS = 0.011;   // one cent, plus float slack

export function usPolyOffers(book, leg, wantYes, { eps = US_TOUCH_EPS } = {}) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  if (!bids.length || !asks.length) return { offers: [], reason: "noOffers" };

  const near = (x, y) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y)
    && Math.abs(x - y) < eps;
  const bBid = bids[0].price, bAsk = asks[0].price;

  const direct = near(bBid, leg?.bid) && near(bAsk, leg?.ask);
  const mirror = near(1 - bAsk, leg?.bid) && near(1 - bBid, leg?.ask);
  // Both matching means the book is symmetric about 50c and the test
  // cannot tell the sides apart. Ambiguous is not aligned.
  if (direct === mirror) return { offers: [], reason: direct ? "ambiguous" : "misaligned" };

  const flip = rows => rows.map(l => ({ price: 1 - l.price, size: l.size }));
  const yesAsks = direct ? asks : flip(bids);
  const yesBids = direct ? bids : flip(asks);

  return {
    offers: sortOffers(wantYes ? yesAsks : flip(yesBids)),
    reason: null,
    side: direct ? "direct" : "mirrored",
  };
}

// What a given size costs and pays, read off the walked curve.
//
// The card used to price every size at the TOUCH, which is right up to
// the touch's own depth and wrong past it — and the card was
// simultaneously advertising a size ten times larger, taken from the
// walk. Two calculators for one trade, differing by 7x on the money.
//
// Every curve point is a level boundary and the marginal price is
// constant between boundaries, so profit is linear in between and a
// straight interpolation is EXACT, not approximate. That only holds
// while the curve carries every boundary, which is why profitCurve's
// cap is set above any real ladder rather than at a round number.
export function positionOnCurve(curve, n) {
  const pts = Array.isArray(curve) ? curve.filter(p => p && Number.isFinite(p.n)) : [];
  if (!pts.length || !Number.isFinite(n) || n < 1) return null;

  const first = pts[0], last = pts[pts.length - 1];
  // Below the first boundary everything fills at the touch, so profit
  // is proportional. Above the last, the ladder is exhausted — report
  // the deepest real fill rather than inventing contracts.
  if (n <= first.n) {
    return { contracts: n, profit: first.total * (n / first.n), capped: false, exact: n === first.n };
  }
  if (n >= last.n) return { contracts: last.n, profit: last.total, capped: true, exact: true };

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (n <= b.n) {
      const t = (n - a.n) / (b.n - a.n);
      return { contracts: n, profit: a.total + t * (b.total - a.total), capped: false, exact: n === b.n };
    }
  }
  return { contracts: last.n, profit: last.total, capped: true, exact: true };
}
