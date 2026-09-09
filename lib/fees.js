// Executable cost: what crossing the spread actually costs, fees included.
//
// v1 stored a single mid price per side and the arb check compared mids,
// so every "edge" the site displayed was the edge available to someone
// who could trade at the midpoint on both venues — which is nobody. Two
// costs were missing:
//
//   1. The spread. A Kalshi book of bid 0.50 / ask 0.54 has a mid of
//      0.52; taking it costs 0.54. On a two-leg trade that error is
//      paid twice.
//   2. Fees. Both venues charge takers, neither charges makers, and
//      both use the same quadratic shape — most expensive at 50/50,
//      approaching zero at the extremes.
//
// Fee PARAMETERS come from each venue's API rather than being written
// down here (Kalshi: /series/<ticker>.fee_multiplier and .fee_type;
// Polymarket: market.feeSchedule). Rates change — Polymarket's sports
// rate moved during 2026 — and a hardcoded number would go quietly
// stale in exactly the way that produces confident wrong answers.

// Kalshi: fee = contracts x 0.07 x fee_multiplier x p x (1-p), rounded
// up to the next cent. The 0.07 base is the published exchange rate;
// fee_multiplier is per-series (0.5 on KXMLBGAME) and defaults to 1.
const KALSHI_BASE_RATE = 0.07;

export function kalshiTakerFee(price, contracts = 1, feeMultiplier = 1) {
  const p = Number(price);
  if (!isFinite(p) || p <= 0 || p >= 1) return 0;
  const mult = isFinite(Number(feeMultiplier)) ? Number(feeMultiplier) : 1;
  const raw = contracts * KALSHI_BASE_RATE * mult * p * (1 - p);
  // Rounded up to the cent per ORDER, not per contract. Applying it to
  // a single contract charges 1.00c where the true rate is 0.875c — a
  // 14% overstatement that would show up as fees eating edges that
  // actually clear. Per-contract economics therefore have to amortise
  // over a realistic order size; see DEFAULT_ORDER_SIZE.
  return Math.ceil(raw * 100) / 100;
}

// Polymarket: fee = shares x rate x (p x (1-p))^exponent, taker only.
// Verified against their published ceiling for sports: 100 shares at
// p=0.50 with rate 0.05 gives $1.25.
export function polymarketTakerFee(price, shares = 1, feeSchedule = null) {
  const p = Number(price);
  if (!isFinite(p) || p <= 0 || p >= 1) return 0;
  if (!feeSchedule) return 0; // feesEnabled false, or a market that predates fees

  const rate = Number(feeSchedule.rate);
  if (!isFinite(rate) || rate <= 0) return 0;
  const exponent = isFinite(Number(feeSchedule.exponent)) ? Number(feeSchedule.exponent) : 1;

  return shares * rate * Math.pow(p * (1 - p), exponent);
}

// Both venues' fees are linear in size (Kalshi's rounding aside), so
// the per-contract figure barely moves with this. It exists to keep
// Kalshi's per-order cent-rounding from being charged in full against a
// single contract.
export const DEFAULT_ORDER_SIZE = 100;

// Per-contract cost of taking a side: pay the ask, then the amortised
// taker fee on it. Returns null when there is no ask to take — an empty
// book is not a free trade, and reading a missing ask as zero would
// invent arbitrage out of illiquidity.
export function takeCost({ ask, venue, feeMultiplier, feeSchedule, size = DEFAULT_ORDER_SIZE }) {
  const a = Number(ask);
  if (!isFinite(a) || a <= 0 || a >= 1) return null;
  const n = Number(size) > 0 ? Number(size) : DEFAULT_ORDER_SIZE;
  const fee = venue === "kalshi"
    ? kalshiTakerFee(a, n, feeMultiplier)
    : polymarketTakerFee(a, n, feeSchedule);
  return a + fee / n;
}

// The two-leg trade: buy YES on one venue and NO on the other, so the
// pair pays out exactly $1 whichever way it resolves. Profitable only
// if both legs together cost less than that.
//
// Returns null when either leg is untakeable, rather than a
// conservative-looking number: "no executable price" and "no edge" are
// different answers and the UI should not conflate them.
export function twoLegArb(legA, legB) {
  const costA = takeCost(legA);
  const costB = takeCost(legB);
  if (costA == null || costB == null) return null;

  const total = costA + costB;
  return {
    costA,
    costB,
    total,
    // Payout is exactly 1.00 per matched pair of contracts.
    edge: 1 - total,
    profitable: total < 1,
  };
}

// How many contracts a leg can actually absorb at the touch.
//
// The arb maths prices one contract and silently assumes the quote
// holds for the whole order. It does not: on live Kalshi books the same
// family of Bitcoin strikes offered 7 contracts at one price and 710 at
// another, which is the difference between six cents of profit and
// fifteen dollars. An edge without a size is not a finding.
//
// Kalshi publishes size on the YES book only, but that is enough for
// both directions: taking the NO side at `no_ask` is the same trade as
// selling YES at `yes_bid`, so the YES bid queue is what backs it.
//
// Polymarket's Gamma endpoint publishes no depth at all — only
// aggregate liquidity — so its legs return null, meaning UNKNOWN rather
// than zero or unlimited.
function legSize(venue, side, kalshi, poly) {
  if (venue === "kalshi") {
    return side === "yes" ? numOrNull(kalshi.yesAskSize) : numOrNull(kalshi.yesBidSize);
  }
  // Polymarket US publishes bidDepth/askDepth on its /bbo endpoint;
  // polymarket.com publishes no depth at all and passes null here, which
  // means UNKNOWN and leaves maxContracts an upper bound.
  return side === "yes" ? numOrNull(poly?.yesAskSize) : numOrNull(poly?.yesBidSize);
}

function numOrNull(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

// Best of the two directions: YES here / NO there, or the reverse.
export function bestArb(kalshi, poly, { size = DEFAULT_ORDER_SIZE } = {}) {
  const k = { venue: "kalshi", feeMultiplier: kalshi.feeMultiplier, size };
  const p = { venue: "polymarket", feeSchedule: poly.feeSchedule, size };

  const candidates = [
    {
      side: "kalshi-yes/poly-no",
      r: twoLegArb({ ...k, ask: kalshi.yesAsk }, { ...p, ask: poly.noAsk }),
      sizes: [legSize("kalshi", "yes", kalshi, poly), legSize("polymarket", "no", kalshi, poly)],
    },
    {
      side: "poly-yes/kalshi-no",
      r: twoLegArb({ ...p, ask: poly.yesAsk }, { ...k, ask: kalshi.noAsk }),
      sizes: [legSize("polymarket", "yes", kalshi, poly), legSize("kalshi", "no", kalshi, poly)],
    },
  ].filter(c => c.r != null);

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, c) => (c.r.total < a.r.total ? c : a));

  // The binding constraint is the smaller leg. We can only see one of
  // them, so this is an upper bound on tradeable size, not a promise —
  // `depthKnown` says which.
  const known = best.sizes.filter(v => v != null);
  const maxContracts = known.length ? Math.min(...known) : null;

  return {
    ...best,
    maxContracts,
    depthKnown: known.length === best.sizes.length,
  };
}

// A 0/1 BOOK IS NOT A BOOK, IT IS AN EMPTY ONE.
//
// Both venues quote an untraded market as best bid 0 / best ask 1 —
// there are no orders, so the touch is the whole probability range.
// Taken literally that is a two-sided market 100 points wide, and the
// card said so: "widest book 100.0pt" beside a leg reading "no
// executable price". It also fed bookMid, which averaged 0 and 1 to a
// confident-looking 50% and displayed it as the venue's price.
//
// BOTH edges are required. A one-sided book — a real bid with nothing
// offered, or an offer with no bid — is genuinely quoted and stays,
// because "you can sell but not buy" is a fact about the market rather
// A BOOK THIS WIDE IS NOT A QUOTE, AND ITS MIDPOINT IS NOT A PRICE.
//
// realBook() below empties a LITERAL 0/1 book. A book of 0.07/0.92 is
// one tick away from that and has the identical problem: the midpoint
// is arithmetic, not information. Measured 2026-09-08, 92 displayed
// legs carried a book over 80 points wide and every one of them
// rendered as "POLY GLOBAL 50%".
//
// The venue confirms it directly. 126 of the 127 college-football
// games listed for Sep 18-19 had NEVER TRADED — `volumeNum` null,
// `lastTradePrice` null — and their `outcomePrices` read
// ["0.495","0.505"], which is a placeholder rather than a price. So
// both available sources are fabricated for these markets, not just
// the book.
//
// THE THRESHOLD IS MEASURED, NOT CHOSEN. Across 780 displayed legs the
// widest book belonging to a market with any recorded volume is
// 34.0 POINTS. Every leg wider than that has never traded: cutting at
// 40 nulls 115 legs and zero of them have traded, and the same holds
// at every higher cut. 40 sits in the gap with a margin rather than on
// the edge of the observed data.
//
// It is deliberately NOT applied to the executable price. An ask of
// 0.92 is real and takeable however wide the book is, so emptying the
// book would discard a genuine quote and understate what a leg costs.
// This governs the DISPLAYED midpoint only.
export const WIDE_BOOK_PTS = 40;

// True when a two-sided book is narrow enough for its midpoint to mean
// something. A one-sided or absent book is not this function's
// business — realBook() has already decided that — so an unreadable
// side answers false rather than being guessed at.
export function midpointIsMeaningful(bid, ask, { maxWidthPts = WIDE_BOOK_PTS } = {}) {
  // null and "" BOTH coerce to 0, so an absent book would otherwise
  // read as a valid zero-width one quoted at nothing — the same
  // Number(null) trap that once mirrored an absent Polymarket book
  // into a {bid: 1, ask: 1} quote. Rejected before coercion.
  if (bid == null || ask == null || bid === "" || ask === "") return false;
  const b = Number(bid), a = Number(ask);
  if (!isFinite(b) || !isFinite(a)) return false;
  if (a < b) return false;
  return (a - b) * 100 < maxWidthPts;
}

// than an absence of one.
export function realBook(bid, ask) {
  const b = Number(bid), a = Number(ask);
  if (Number.isFinite(b) && Number.isFinite(a) && b <= 0 && a >= 1) {
    return { bid: null, ask: null };
  }
  return { bid, ask };
}

// Polymarket publishes one book per market, quoted on outcome 0. In a
// binary CLOB the other outcome is its exact complement: what you can
// sell outcome 0 for is what buying outcome 1 must cost.
export function complementBook(bid, ask) {
  // Number(null) IS 0, and Number("") is 0 too, so the finite check
  // alone let an ABSENT book through as 0/0 and mirrored it into a
  // { bid: 1, ask: 1 } quote — a venue offering to sell at $1.00 that
  // does not exist. bestArb prices that out of any edge, so it hid in
  // the arb figure and surfaced as a 100% mid on the card instead.
  if (bid == null || ask == null || bid === "" || ask === "") {
    return { bid: null, ask: null };
  }
  const b = Number(bid), a = Number(ask);
  if (!isFinite(b) || !isFinite(a)) return { bid: null, ask: null };
  // Rounded: 1 - 0.55 is 0.44999999999999996 in binary floating point,
  // and these values are compared and displayed as prices.
  const r = x => Math.round(x * 10000) / 10000;
  return { bid: r(1 - a), ask: r(1 - b) };
}

// ── Priced at a size you could actually fill ────────────────────────
//
// DEFAULT_ORDER_SIZE is a modelling convention — "a realistic order" —
// that exists to stop Kalshi's per-order cent rounding being charged in
// full against one contract. It stops being realistic the moment the
// book holds less than that, and on live data that is not an edge case:
// 302 of 669 legs have a ceiling under 100 contracts.
//
// The error is not small either. The rounding amortises over whatever
// size you actually trade, so a 4-contract book pays that cent over 4
// rather than 100 — measured at up to 0.92c per pair, and enough to
// flip a real market from "arb" to loss (an econ pair quoted 99.979c at
// the convention size and 100.149c at the four contracts on offer).
//
// So: price at the size on offer, capped at the convention. Only ever
// SMALLER — past ~100 contracts the rounding is already amortised to
// nothing, so there is no reason to model a larger order than that.
//
// `maxContracts` can itself be an upper bound (Polymarket publishes no
// depth on .com), so this is less optimistic than pricing at 100, not
// a guarantee. `depthKnown` still says which.
export function tradeableArb(kalshi, poly) {
  const at = bestArb(kalshi, poly);
  if (!at) return null;

  const mc = at.maxContracts;
  if (mc == null) return { ...at, pricedAt: DEFAULT_ORDER_SIZE };

  const n = Math.max(1, Math.min(DEFAULT_ORDER_SIZE, Math.floor(mc)));
  if (n >= DEFAULT_ORDER_SIZE) return { ...at, pricedAt: DEFAULT_ORDER_SIZE };

  const repriced = bestArb(kalshi, poly, { size: n });
  return repriced ? { ...repriced, pricedAt: n } : { ...at, pricedAt: DEFAULT_ORDER_SIZE };
}

// ── What a given position actually pays ─────────────────────────────
//
// The card reports an edge per contract. The question a reader asks
// next is "so what do I make", and multiplying is the wrong answer:
//
//   1. KALSHI'S FEE IS ROUNDED UP TO THE CENT PER ORDER, not per
//      contract. At one contract that is 1.00c against a true 0.875c —
//      14% high — so the per-contract cost genuinely CHANGES with size,
//      and it changes most at the small sizes a first-time reader will
//      type. `edge x N` overstates a small order and understates a
//      large one.
//   2. The direction can flip. bestArb picks between "Kalshi YES /
//      Poly NO" and the reverse by total cost, and because of that
//      rounding the cheaper direction at 5 contracts is not necessarily
//      the cheaper one at 500. So this re-runs the whole comparison at
//      the requested size rather than scaling the winner.
//
// Size is CLAMPED to what the book can absorb. Quoting a profit on
// 1,000 contracts when the touch holds 7 is the same failure as quoting
// a midpoint: a number for a trade that does not exist. `depthKnown`
// says whether that ceiling is real or an upper bound taken from the
// Kalshi leg alone — Polymarket publishes no depth on .com.
export function positionAtSize(kalshi, poly, contracts, { clamp = true } = {}) {
  const asked = Math.floor(Number(contracts));
  if (!isFinite(asked) || asked < 1) return null;

  // Priced at the clamped size, because that is the trade on offer.
  const ceiling = clamp ? tradeableArb(kalshi, poly)?.maxContracts ?? null : null;
  const n = ceiling != null ? Math.min(asked, ceiling) : asked;
  if (n < 1) return null;

  const best = bestArb(kalshi, poly, { size: n });
  if (!best) return null;

  const costPerPair = best.r.total;
  return {
    side: best.side,
    asked,
    contracts: n,
    // So the UI can say "we sized this down" rather than silently
    // answering a different question from the one that was asked.
    clamped: n < asked,
    maxContracts: best.maxContracts,
    depthKnown: best.depthKnown,
    costPerPair,
    edgePerPair: 1 - costPerPair,
    totalCost: costPerPair * n,
    // A matched pair pays exactly $1 whichever way it resolves.
    payout: n,
    profit: (1 - costPerPair) * n,
    profitable: costPerPair < 1,
  };
}

// ── An edge is not a return until you divide by time ────────────
//
// THE NUMBER EVERY TOOL IN THIS SPACE LEAVES OUT, including this one
// until now. Measured on live pairs, 2026-09-09:
//
//   CONTROLS-2026-D    +1.25c edge, 36,942 contracts -> "$461.77"
//                      = $36,480 of capital, locked 144 days
//                      = 3.2% a year
//   KXPRESNOMR-28-JDV  +1.46c edge -> "$212.56"
//                      = $14,346 locked 789 DAYS = 0.7% a year
//
// Both are worse than a Treasury bill. The headline dollar figure is
// arithmetically true and economically misleading: it is the profit
// with no mention of the capital it consumes or how long it is gone
// for. A competitor advertising "1-8% typical ROI" is quoting raw
// edge, which is the same omission.
//
// A matched pair pays $1 at settlement and costs `total` now, so the
// capital IS the cost and the return on it is edge/total. Dividing by
// the holding period is what turns "$461" into a decision.
//
// SIMPLE annualisation, not compounded: this is a single settlement,
// not a reinvested position, and compounding a one-shot payoff would
// overstate a long-dated market — exactly the case that most needs
// telling straight.
export function annualizedReturn(edge, total, daysToResolve) {
  const e = Number(edge), t = Number(total), d = Number(daysToResolve);
  if (!isFinite(e) || !isFinite(t) || t <= 0) return null;
  if (!isFinite(d) || d <= 0) return null;
  // Under a day the figure explodes and stops meaning anything — a
  // 1c edge settling in an hour annualises to thousands of percent,
  // which is true and useless. Floored at one day.
  return Math.round((e / t) * (365 / Math.max(d, 1)) * 1000) / 10;
}

// Days until the market settles, from Kalshi's close_time. Returns
// null rather than a guess: an unknown horizon must not render as
// "settles today", which would make every long-dated arb look urgent.
export function daysUntil(closeTime, now = Date.now()) {
  if (!closeTime) return null;
  const t = typeof closeTime === "number" ? closeTime : Date.parse(closeTime);
  if (!isFinite(t)) return null;
  const days = (t - now) / 86400000;
  return days > 0 ? Math.round(days * 10) / 10 : null;
}
