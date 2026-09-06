// positionAtSize: what a given trade actually pays.
//
// Pinned because the obvious implementation — edge x contracts — is
// wrong, and wrong in the direction that flatters a small order. Kalshi
// rounds its taker fee UP TO THE CENT PER ORDER, so the per-contract
// cost really does move with size, and it moves most at the sizes a
// first-time reader types.
import {
  positionAtSize, bestArb, tradeableArb, kalshiTakerFee, DEFAULT_ORDER_SIZE,
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

// ── tradeableArb: the headline priced at a fillable size ────────────
{
  // A THIN book must be priced at what it holds, not at the convention.
  // n=7, not n=4: at 4 contracts this fixture's fee lands exactly on a
  // cent boundary and the two sizes agree, so the assertion would pass
  // while proving nothing. The rounding penalty is real but lumpy —
  // +0.25c at 1-3 contracts here, 0 at 4, +0.107c at 7.
  const kThin = { ...K, yesAskSize: 7, yesBidSize: 7 };
  const at100 = bestArb(kThin, P);
  const tr = tradeableArb(kThin, P);
  eq(tr.pricedAt, 7, "thin book is priced at the seven contracts on offer");
  eq(tr.r.total > at100.r.total, true, "and that costs MORE per pair than the convention size");
  // Weakly true for EVERY thin book, lumpiness or not: amortising a
  // rounded-up cent over fewer contracts can never be cheaper.
  for (const n of [1, 2, 3, 4, 7, 11, 50]) {
    const kn = { ...K, yesAskSize: n, yesBidSize: n };
    eq(tradeableArb(kn, P).r.total >= bestArb(kn, P).r.total, true,
       `a ${n}-contract book is never cheaper per pair than the convention size`);
  }
  // The calculator's default and the headline must land on one number,
  // or the panel shows two prices for the same trade a few pixels apart.
  const pos = positionAtSize(kThin, P, DEFAULT_ORDER_SIZE);
  near(pos.costPerPair, tr.r.total, "headline and calculator agree at the tradeable size");
}
{
  // A DEEP book keeps the convention: past ~100 the rounding is already
  // amortised, so modelling a larger order would change nothing.
  const kDeep = { ...K, yesAskSize: 50000, yesBidSize: 50000 };
  eq(tradeableArb(kDeep, P).pricedAt, DEFAULT_ORDER_SIZE, "deep book still priced at the convention");
  near(tradeableArb(kDeep, P).r.total, bestArb(kDeep, P).r.total, "deep book price is unchanged");
}
{
  // No known ceiling -> nothing to clamp to, so the convention stands.
  const kNoSize = { ...K, yesAskSize: null, yesBidSize: null };
  const tr = tradeableArb(kNoSize, P);
  eq(tr.pricedAt, DEFAULT_ORDER_SIZE, "unknown depth keeps the convention size");
  eq(tr.maxContracts, null, "and reports no ceiling");
}
{
  // The real case this change exists for: a pair that clears at the
  // convention size and does NOT clear at the size actually on offer.
  // Measured live on an econ pair: 99.979c -> 100.149c at 4 contracts.
  const kEdge = { yesAsk: 0.40, noAsk: 0.99, yesAskSize: 3, yesBidSize: 3, feeMultiplier: 1 };
  const pEdge = { yesAsk: 0.99, noAsk: 0.57, yesAskSize: null, yesBidSize: null,
                  feeSchedule: { rate: 0.05, exponent: 1 } };
  const a = bestArb(kEdge, pEdge), t = tradeableArb(kEdge, pEdge);
  eq(a.r.profitable && !t.r.profitable, true,
     "an edge that only exists at unfillable size is no longer called profitable");
}
{
  // An untakeable pair stays null rather than becoming a priced one.
  eq(tradeableArb({ ...K, yesAsk: null, noAsk: null }, P), null, "no ask yields null");
}

console.log(bad ? `${bad} failing` : "position-size: all cases pass");
process.exit(bad ? 1 : 0);
