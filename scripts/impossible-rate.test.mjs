// A deeper fill cannot earn more per contract than the touch.
//
// The touch is the best price on each side by definition, so every
// level beneath it is worse and the running average can only fall. A
// walk reporting a HIGHER per-contract edge than the verified touch has
// not found a better trade — it has priced something the touch
// disagrees with, and the card renders that disagreement as money.
//
// Live, 2026-09-19: a college football leg reported 0.68c at the touch
// and 3.74c walked, and an MLB card showed "+4.1c ... 12.85c averaged
// over every price you'd take" beside copy promising LESS per contract.
import { profitCurve, sortOffers } from "../lib/depthLadder.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

// The guard, as implemented in attachDepthLadders.
const publishable = (curveBest, touchEdge) =>
  !(Number.isFinite(touchEdge) && curveBest.edgePerPair > touchEdge + 1e-9);

console.log("a well-formed walk degrades, and is publishable");
{
  const legA = { venue: "kalshi", feeMultiplier: 1,
                 offers: sortOffers([["0.49", "1544"], ["0.50", "6559"]]) };
  const legB = { venue: "poly", feeSchedule: null, offers: sortOffers([["0.45", "50000"]]) };
  const r = profitCurve(legA, legB);
  ok(r.best.edgePerPair < r.curve[0].edgePerPair,
     "the rate falls as size grows — the property the whole feature rests on");
  ok(publishable(r.best, r.curve[0].edgePerPair), "and it passes the guard");
}

console.log("\na walk that beats its own touch is refused");
{
  // The live shape: the ladder prices better than the verified touch,
  // so the average edge exceeds what tradeableArb computed.
  const touchEdge = 0.0068;                       // 0.68c, verified
  ok(!publishable({ edgePerPair: 0.0374 }, touchEdge),
     "3.74c walked against a 0.68c touch is suppressed");
  ok(!publishable({ edgePerPair: 0.1285 }, 0.0410),
     "12.85c walked against a 4.10c touch is suppressed");
}

console.log("\nthe boundary, and what must still publish");
{
  ok(publishable({ edgePerPair: 0.0068 }, 0.0068), "exactly equal still publishes");
  ok(publishable({ edgePerPair: 0.0067 }, 0.0068), "a hair below publishes");
  ok(!publishable({ edgePerPair: 0.0069 }, 0.0068), "a hair above does not");
  // Float noise must not suppress a legitimate walk.
  ok(publishable({ edgePerPair: 0.0068 + 1e-12 }, 0.0068),
     "float noise within the epsilon is tolerated");
}

console.log("\nan unknown touch cannot be compared, so it does not block");
{
  ok(publishable({ edgePerPair: 0.05 }, null), "a null touch edge leaves the walk alone");
  ok(publishable({ edgePerPair: 0.05 }, undefined), "so does an absent one");
  ok(publishable({ edgePerPair: 0.05 }, NaN), "and a NaN");
  // Deliberate: the guard exists to catch a CONTRADICTION. With nothing
  // to contradict, suppressing would hide working cards for no reason.
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
