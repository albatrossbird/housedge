// What a suppressed walk must record about itself.
//
// Three explanations were offered for the impossible-rate cards and all
// three were wrong: that Kalshi's sizes were not contracts (they are —
// `_fp` is fixed-point and the exchange supports fractional
// contracts), that the ladder priced a cent under the quote (it does
// not; measured same-instant, `1 - no_best_bid` equals `yes_ask`
// exactly), and that the US alignment check mis-branched (it behaves
// correctly on every live leg tested).
//
// Each was reasoned from inputs nobody had looked at AT THE MOMENT THE
// GUARD FIRED, because by the time anyone looked the books had turned
// over. So the sample has to carry enough to redo the arithmetic
// without the live book — which is what this pins.
import { profitCurve, sortOffers } from "../lib/depthLadder.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

// Mirror of the sample builder in attachDepthLadders.
const lv = (rows, n = 6) => (rows || []).slice(0, n)
  .map(l => [Math.round(l.price * 1e4) / 1e4, Math.round(l.size * 100) / 100]);

function buildSample({ id, venue, usSide, touchEdge, kOffers, pOffers, curve, inputs }) {
  return {
    kalshiId: id, venue, usSide, side: "kalshi-yes/poly-no",
    touch: { edge: touchEdge, pricedAt: 100, maxContracts: 58,
             ageSeconds: 172, kalshi: inputs.kalshi, poly: inputs.poly },
    walked: { kalshiOffers: lv(kOffers), polyOffers: lv(pOffers),
              kalshiLevels: kOffers.length, polyLevels: pOffers.length },
    curveHead: curve.curve.slice(0, 4).map(c => ({ n: c.contracts, edge: Math.round(c.edgePerPair * 1e4) / 1e4 })),
    best: { n: curve.best.contracts, edge: curve.best.edgePerPair },
  };
}

// A walk that beats its touch — the live shape, reconstructed.
const kOffers = sortOffers([["0.27", "58"], ["0.28", "4000"], ["0.29", "70000"]]);
const pOffers = sortOffers([["0.60", "9000"], ["0.62", "80000"]]);
const curve = profitCurve(
  { venue: "kalshi", feeMultiplier: 1, offers: kOffers },
  { venue: "poly", feeSchedule: null, offers: pOffers });
const sample = buildSample({
  id: "KXMLBGAME-26SEP19MILBAL-BAL", venue: "Polymarket US", usSide: "mirrored",
  touchEdge: 0.041, kOffers, pOffers, curve,
  inputs: { kalshi: { yesAsk: 0.2736, yesAskSize: 58 }, poly: { yesAsk: 0.6854 } },
});

console.log("the sample identifies WHICH leg, on which venue");
{
  ok(sample.kalshiId === "KXMLBGAME-26SEP19MILBAL-BAL", "the Kalshi ticker");
  ok(sample.venue === "Polymarket US", "the venue");
  ok(sample.usSide === "mirrored", "and which branch the US alignment took");
  // That last one matters: "the alignment mis-branched" was a whole
  // hypothesis, and nothing recorded which branch was taken.
  ok(sample.side === "kalshi-yes/poly-no", "and which side of each book is being bought");
}

console.log("\nit carries both ladders AS WALKED, not the raw payloads");
{
  ok(Array.isArray(sample.walked.kalshiOffers) && sample.walked.kalshiOffers.length,
     "the Kalshi ladder is present");
  ok(sample.walked.kalshiOffers[0][0] === 0.27, "cheapest first, side already resolved");
  ok(sample.walked.polyOffers[0][0] === 0.6, "and the Polymarket one too");
  // Sizes are what the "not contracts" hypothesis was about, so they
  // have to be in the record rather than inferred from a total.
  ok(sample.walked.kalshiOffers[0][1] === 58, "with sizes, at the level");
  ok(sample.walked.kalshiLevels === 3 && sample.walked.polyLevels === 2,
     "and the true level counts, so truncation is visible");
}

console.log("\nit carries the touch the walk is being judged against");
{
  ok(sample.touch.edge === 0.041, "the edge tradeableArb computed");
  ok(sample.touch.kalshi.yesAsk === 0.2736 && sample.touch.poly.yesAsk === 0.6854,
     "and the prices it computed that from");
  // The leading untested suspect: a stale stored touch against a live
  // ladder. Unreadable without the age.
  ok(sample.touch.ageSeconds === 172, "and how old those quotes were");
}

console.log("\nthe arithmetic can be redone from the sample alone");
{
  const [p0, s0] = sample.walked.kalshiOffers[0];
  const [q0] = sample.walked.polyOffers[0];
  const crude = 1 - (p0 + q0);
  ok(Math.abs(crude - 0.13) < 1e-9,
     `buying 0.27 + 0.60 leaves ${crude.toFixed(4)} before fees — checkable by hand`);
  ok(sample.curveHead.length > 0 && sample.curveHead[0].n === curve.curve[0].contracts,
     "and the curve head lines up with the first fillable size");
  ok(sample.best.edge > sample.touch.edge,
     "the contradiction itself is in the record, not just the fact it was caught");
}

console.log("\nthe sample is small enough to always include");
{
  const bytes = JSON.stringify(sample).length;
  ok(bytes < 1200, `${bytes} bytes — three of these is negligible on a 1.4MB response`);
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
