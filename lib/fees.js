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
function legSize(venue, side, kalshi) {
  if (venue !== "kalshi") return null;
  return side === "yes" ? numOrNull(kalshi.yesAskSize) : numOrNull(kalshi.yesBidSize);
}

function numOrNull(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : null;
}

// Best of the two directions: YES here / NO there, or the reverse.
export function bestArb(kalshi, poly) {
  const k = { venue: "kalshi", feeMultiplier: kalshi.feeMultiplier };
  const p = { venue: "polymarket", feeSchedule: poly.feeSchedule };

  const candidates = [
    {
      side: "kalshi-yes/poly-no",
      r: twoLegArb({ ...k, ask: kalshi.yesAsk }, { ...p, ask: poly.noAsk }),
      sizes: [legSize("kalshi", "yes", kalshi), null],
    },
    {
      side: "poly-yes/kalshi-no",
      r: twoLegArb({ ...p, ask: poly.yesAsk }, { ...k, ask: kalshi.noAsk }),
      sizes: [null, legSize("kalshi", "no", kalshi)],
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

// Polymarket publishes one book per market, quoted on outcome 0. In a
// binary CLOB the other outcome is its exact complement: what you can
// sell outcome 0 for is what buying outcome 1 must cost.
export function complementBook(bid, ask) {
  const b = Number(bid), a = Number(ask);
  if (!isFinite(b) || !isFinite(a)) return { bid: null, ask: null };
  // Rounded: 1 - 0.55 is 0.44999999999999996 in binary floating point,
  // and these values are compared and displayed as prices.
  const r = x => Math.round(x * 10000) / 10000;
  return { bid: r(1 - a), ask: r(1 - b) };
}
