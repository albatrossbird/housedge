// An edge is not a return until you divide by time.
//
// The three cases below are MEASURED from live pairs on 2026-09-09,
// with the annualised figure computed independently from Kalshi's own
// close_time before this function existed. They are the regression: if
// the maths drifts, these stop matching.
//
// Run: node scripts/annualized.test.mjs

import { annualizedReturn, daysUntil } from "../lib/fees.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nmeasured against live pairs");
{
  // "$461.77" of profit — and $36,480 of capital locked for 144 days.
  check("CONTROLS-2026-D is 3.2%/yr", annualizedReturn(0.0125, 0.9875, 144) === 3.2);
  // "$212.56" — over TWO YEARS. Worse than a savings account.
  check("JD Vance nomination is 0.7%/yr", annualizedReturn(0.0146, 0.9854, 789) === 0.7);
  check("CONTROLH-2026-D is 1.7%/yr", annualizedReturn(0.0065, 0.9935, 144) === 1.7);
}

console.log("\nan unknown horizon is null, never a number");
{
  // A missing close_time must not render as "settles today", which
  // would make every long-dated arb look urgent — the exact opposite
  // of what this function exists to correct.
  check("null days", annualizedReturn(0.01, 0.99, null) === null);
  check("zero days", annualizedReturn(0.01, 0.99, 0) === null);
  check("negative days", annualizedReturn(0.01, 0.99, -5) === null);
  check("non-numeric", annualizedReturn(0.01, 0.99, "soon") === null);
  check("zero cost is not infinite return", annualizedReturn(0.01, 0, 30) === null);
}

console.log("\nsub-day horizons are floored, not exploded");
{
  // A 1c edge settling in an hour annualises to thousands of percent —
  // true, and useless. The divisor is floored at one day, so an hour
  // reports the SAME figure as a day rather than exploding.
  //
  // Floored rather than nulled on purpose: the number exists to be
  // compared against alternatives, and a market settling in an hour is
  // a genuinely excellent use of capital. "368%/yr" communicates that,
  // capped; null communicates nothing.
  check("an hour floors to the one-day figure", annualizedReturn(0.01, 0.99, 0.04) === 368.7,
        String(annualizedReturn(0.01, 0.99, 0.04)));
  check("and a day is that same figure", annualizedReturn(0.01, 0.99, 1) === 368.7);
  check("floored, so an hour never exceeds a day", annualizedReturn(0.01, 0.99, 0.04) <= annualizedReturn(0.01, 0.99, 1));
}

console.log("\nthe comparison that matters");
{
  // A Treasury bill is ~4-5%. Anything under that is a worse use of
  // the same capital, and the site should be able to say so.
  const senate = annualizedReturn(0.0125, 0.9875, 144);
  check("the biggest edge on the site loses to a T-bill", senate < 4, `${senate}%/yr`);
  // Same edge, settling in a fortnight, is a completely different trade.
  check("the same edge in 14 days is not", annualizedReturn(0.0125, 0.9875, 14) > 30);
}

console.log("\ndaysUntil");
{
  const now = Date.parse("2026-09-09T12:00:00Z");
  check("reads an ISO close_time", daysUntil("2026-11-04T00:00:00Z", now) === 55.5,
        String(daysUntil("2026-11-04T00:00:00Z", now)));
  check("a past date is null, not negative", daysUntil("2020-01-01T00:00:00Z", now) === null);
  check("null in, null out", daysUntil(null, now) === null);
  check("garbage in, null out", daysUntil("whenever", now) === null);
  check("accepts epoch ms", daysUntil(now + 86400000, now) === 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
