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
//
// The headroom is NOT a fudge factor. Kalshi rounds its taker fee up to
// the cent per ORDER, so that cent spread over `pricedAt` contracts is
// the most the per-contract edge may legitimately improve by as the
// order grows. The 5e-5 is because `arb.edge` is reported to four
// decimals and the curve is not.
const publishable = (curveBest, touchEdge, pricedAt = 100) => {
  if (!Number.isFinite(touchEdge)) return true;
  const headroom = 0.01 / Math.max(pricedAt || 1, 1) + 5e-5;
  return !(curveBest.edgePerPair > touchEdge + headroom);
};

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

console.log("\na walk that beats its own touch by REAL money is refused");
{
  ok(!publishable({ edgePerPair: 0.0374 }, 0.0068, 100),
     "3.74c walked against a 0.68c touch is suppressed");
  // The card that started this: +4.10c at the touch, 12.85c walked,
  // priced at 58 contracts. Excess 0.0875 against a 0.00022 allowance.
  ok(!publishable({ edgePerPair: 0.1285 }, 0.0410, 58),
     "the $8,981.86 card is still refused, by a factor of ~400");
}

console.log("\nbut fee amortisation and rounding are NOT contradictions");
{
  // All three measured live on 2026-09-20, all suppressed by the first
  // version of this guard, all legitimate.
  ok(publishable({ edgePerPair: 0.028587 }, 0.0275, 5),
     "Musk wealth: 0.0011 excess at pricedAt=5, inside the 0.00205 the fee rounding allows");
  ok(publishable({ edgePerPair: 0.007366 }, 0.0073, 100),
     "Alaska Senate: 0.0000066 — pure reporting rounding, not a contradiction");
  ok(publishable({ edgePerPair: 0.0179054 }, 0.0179, 37),
     "French president: 0.0000054, likewise");
  // The mechanism, stated as a property: a thinner touch earns more
  // headroom, because the rounded cent is spread over fewer contracts.
  // The FEE term scales exactly inversely with size; the 5e-5 rounding
  // floor is flat and dominates once the order is large, which is why
  // the total allowance does not scale 100x even though the fee part
  // does. Asserting the ratio of the totals would have been asserting
  // arithmetic I had not done — it is 29x, not 100x.
  const feeTerm = n => 0.01 / n;
  ok(feeTerm(5) === feeTerm(500) * 100, "the fee term is exactly 100x thinner at 500 than at 5");
  const thin = feeTerm(5) + 5e-5, fat = feeTerm(500) + 5e-5;
  ok(thin > fat, `a thin touch earns more headroom: ${thin.toFixed(5)} vs ${fat.toFixed(5)}`);
  ok(fat > 5e-5, "and the floor never swallows the fee term entirely");
  ok(!publishable({ edgePerPair: 0.0275 + thin + 1e-6 }, 0.0275, 5),
     "and a hair past even the thin allowance is still refused");
}

console.log("\nthe boundary, and what must still publish");
{
  ok(publishable({ edgePerPair: 0.0068 }, 0.0068), "exactly equal still publishes");
  ok(publishable({ edgePerPair: 0.0067 }, 0.0068), "a hair below publishes");
  ok(publishable({ edgePerPair: 0.0069 }, 0.0068, 100),
     "a hair above publishes too — 0.0001 is inside the fee allowance at 100");
  ok(!publishable({ edgePerPair: 0.0068 + 0.01 / 100 + 5e-5 + 1e-6 }, 0.0068, 100),
     "a hair past the allowance does not");
  ok(publishable({ edgePerPair: 0.0068 + 1e-12 }, 0.0068),
     "float noise is tolerated");
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
