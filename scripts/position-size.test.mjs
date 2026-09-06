// positionAtSize: what a given trade actually pays.
//
// Pinned because the obvious implementation — edge x contracts — is
// wrong, and wrong in the direction that flatters a small order. Kalshi
// rounds its taker fee UP TO THE CENT PER ORDER, so the per-contract
// cost really does move with size, and it moves most at the sizes a
// first-time reader types.
import {
  positionAtSize, bestArb, kalshiTakerFee, DEFAULT_ORDER_SIZE,
} from "../lib/fees.js";

let bad = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { bad++; console.error(`FAIL ${what}\n  got:  ${g}\n  want: ${w}`); }
};
const near = (got, want, what, eps = 1e-9) => {
  if (!(Math.abs(got - want) <= eps)) { bad++; console.error(`FAIL ${what}\n  got:  ${got}\n  want: ~${want}`); }
};

// A profitable pair with a 700-contract Kalshi queue and no Polymarket depth.
const K = { yesAsk: 0.53, noAsk: 0.48, yesAskSize: 700, yesBidSize: 700, feeMultiplier: 1 };
const P = { yesAsk: 0.44, noAsk: 0.46, yesAskSize: null, yesBidSize: null,
            feeSchedule: { rate: 0.05, exponent: 1 } };

{
  // THE HEADLINE: cost per pair is NOT constant in size. A calculator
  // that multiplies the 100-contract edge would overstate one contract.
  const one = positionAtSize(K, P, 1);
  const hundred = positionAtSize(K, P, 100);
  eq(one.costPerPair > hundred.costPerPair, true, "one contract costs MORE per pair than a hundred");
  eq(one.profit < hundred.profit / 100, true, "profit is sublinear at small size");
  // And the reason is Kalshi's per-order cent rounding, not the rate.
  // 1 x 0.07 x 0.53 x 0.47 = $0.01744, rounded up to $0.02 — so a
  // single contract pays 2c where a hundred pay 1.75c each.
  near(kalshiTakerFee(0.53, 1, 1), 0.02, "one contract pays a rounded-up cent");
  near(kalshiTakerFee(0.53, 100, 1), 1.75, "a hundred contracts pay the true rate");
}
{
  // Payout is exactly $1 per matched pair, so profit is edge x size at
  // the size it was PRICED at — the invariant the display rests on.
  const r = positionAtSize(K, P, 50);
  eq(r.contracts, 50, "asked size honoured when the book can absorb it");
  eq(r.clamped, false, "not clamped below the ceiling");
  near(r.payout, 50, "payout is $1 per pair");
  near(r.totalCost, r.costPerPair * 50, "total cost is cost/pair x size");
  near(r.profit, r.payout - r.totalCost, "profit is payout minus cost");
  near(r.edgePerPair, 1 - r.costPerPair, "edge per pair is 1 - cost");
}
{
  // CLAMPED TO THE BOOK. Quoting a profit on size the touch cannot
  // absorb is the same failure as quoting a midpoint.
  const r = positionAtSize(K, P, 5000);
  eq(r.contracts, 700, "clamped to the Kalshi queue");
  eq(r.asked, 5000, "what was asked for is preserved");
  eq(r.clamped, true, "clamping is reported, not silent");
  eq(r.depthKnown, false, "Polymarket .com publishes no depth, so this is an upper bound");
}
{
  // Depth known on both legs: the ceiling is real, and it is the SMALLER.
  const pUs = { ...P, yesAskSize: 40, yesBidSize: 40 };
  const r = positionAtSize(K, pUs, 5000);
  eq(r.depthKnown, true, "both legs sized means the ceiling is real");
  eq(r.contracts, 40, "the binding leg is the smaller one");
}
{
  // An unprofitable pair still answers — with a loss, not a null. The
  // reader asked what it costs, and "you would lose $2" is the answer.
  // BOTH directions must be expensive: bestArb picks the cheaper of
  // "Kalshi YES / Poly NO" and the reverse, so raising one Kalshi ask
  // just moves the trade to the other side. Getting this wrong is how
  // a test can pass while asserting nothing.
  const kBad = { ...K, yesAsk: 0.62, noAsk: 0.55 };
  const pBad = { ...P, yesAsk: 0.60, noAsk: 0.58 };
  const r = positionAtSize(kBad, pBad, 100);
  eq(r.profitable, false, "expensive pair is not profitable");
  eq(r.profit < 0, true, "a losing trade reports a negative profit, not zero");
}
{
  // No executable price is NOT a free trade — the distinction the whole
  // fees module exists to keep.
  const kEmpty = { ...K, yesAsk: null, noAsk: null };
  eq(positionAtSize(kEmpty, P, 10), null, "no ask yields null, never a number");
}
{
  // Garbage in, null out — never a confident-looking zero.
  eq(positionAtSize(K, P, 0), null, "zero contracts is not a trade");
  eq(positionAtSize(K, P, -5), null, "negative size is not a trade");
  eq(positionAtSize(K, P, "abc"), null, "non-numeric size is not a trade");
  eq(positionAtSize(K, P, 2.7).contracts, 2, "fractional size floors to whole contracts");
}
{
  // bestArb's default must be unchanged by the new size parameter, or
  // every existing arb figure on the site silently moves.
  const a = bestArb(K, P);
  const b = bestArb(K, P, { size: DEFAULT_ORDER_SIZE });
  eq(a.r.total, b.r.total, "default size still means DEFAULT_ORDER_SIZE");
}

console.log(bad ? `${bad} failing` : "position-size: all cases pass");
process.exit(bad ? 1 : 0);
