// Pricing a size off the walked ladder, and the overstatement it replaces.
//
// The card carried two calculators: a depth box advertising 11,317
// contracts for $40.03, and a size input that capped at 1,126 because
// positionAtSize knows one price level. Raising that cap without
// changing the maths would have quoted $59.10 for the same trade —
// worse than the contradiction, because it looks consistent.
// positionOnCurve against the real Newsom ladder shape.
import { positionOnCurve, profitCurve, sortOffers } from "../lib/depthLadder.js";
let bad=0; const ok=(c,w)=>{c?console.log("  ok  "+w):(bad++,console.error("FAIL "+w));};
const near=(a,b,e=1e-9)=>Math.abs(a-b)<e;

const curve=[{n:1126,total:5.88},{n:4000,total:20.00},{n:11317,total:40.03}];

console.log("the two anchor sizes are exact");
ok(near(positionOnCurve(curve,1126).profit,5.88), "touch size -> $5.88");
ok(near(positionOnCurve(curve,11317).profit,40.03), "best size -> $40.03");

console.log("\nbelow the first boundary it scales, above the last it caps");
ok(near(positionOnCurve(curve,563).profit,5.88*563/1126), "half the touch -> half the money");
const over=positionOnCurve(curve,999999);
ok(over.capped && over.contracts===11317 && near(over.profit,40.03),
   "past the ladder it reports the deepest real fill, not invented contracts");

console.log("\nbetween boundaries it interpolates, and that is EXACT");
const mid=positionOnCurve(curve,2563);
ok(near(mid.profit, 5.88+(20.00-5.88)*((2563-1126)/(4000-1126))), "linear between boundaries");
ok(mid.profit>5.88 && mid.profit<20.00, "and lands between the two");

console.log("\nthe old bug: touch rate x size overstates past the touch");
const touchRate=5.88/1126;
ok(touchRate*11317 > 40.03*1.4,
   `pricing 11,317 at the touch rate gives $${(touchRate*11317).toFixed(2)} vs the true $40.03`);

console.log("\nrubbish in, null out");
ok(positionOnCurve([],5)===null && positionOnCurve(curve,0)===null && positionOnCurve(null,5)===null,
   "empty curve, zero size and a missing curve all return null");

console.log(bad?`\n${bad} FAILED`:"\nall passed"); process.exit(bad?1:0);
