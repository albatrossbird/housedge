// A bare month means the SOONEST one still ahead.
//
// Kept out of gate-cases.test.mjs on purpose: this rule reads the
// clock, so a case asserted through scalarSignaturesCompatible would
// change answer as real time passes and eventually stop testing what it
// was written for. The clock is injected here instead.
//
// Run: node scripts/event-month.test.mjs

import { eventMonth, eventMonthsCompatible } from "../lib/v2/claims.js";

const NOW = new Date("2026-09-08T00:00:00Z");
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
const compat = (a, b) => eventMonthsCompatible(a, b, { now: NOW });

console.log("\nthe pair that motivated it — a FULL YEAR apart, scored 0.815");
{
  const A = "Will the Federal Reserve Hike rates by 25bps at their October 2027 meeting?";
  const B = "Fed Decision in October — 25 bps Increase";
  check("A reads October 2027", eventMonth(A)?.month === 9 && eventMonth(A)?.year === 2027);
  check("B reads October, no year", eventMonth(B)?.month === 9 && eventMonth(B)?.year === null);
  check("rejected", compat(A, B) === false);
  // Every existing date rule was inert: neither title states a cutoff,
  // so extractDeadline returns null on both sides. These are MEETING
  // DATES, not deadlines.
}

console.log("\nthe December pairs this repo warns about must survive");
{
  // "Rejecting every bare date would have killed four correct December
  // pairs along with the August one."
  check("Dec 2026 vs bare December", compat(
    "Will Elon Musk’s net worth for December 31, 2026 be above $600 billion?",
    "Elon Musk Net Worth on December 31? — Above $600 Billion") === true);
  check("Dec 2026 vs bare Dec (abbreviated)", compat(
    "Will Bitcoin be above $199,999.99 by Dec 31 2026?",
    "Bitcoin above $200,000 on December 31?") === true);
}

console.log("\nand the August one must not");
{
  check("Dec 2026 vs bare August", compat(
    "Elon Musk Net Worth on December 31, 2026?",
    "Elon Musk Net Worth on August 31?") === false);
}

console.log("\ninert wherever it cannot know");
{
  check("only one side names a month", compat(
    "Will the Fed cut in October 2027?", "Will the Fed cut rates this year?") === true);
  check("neither names a month", compat("Will the Fed cut?", "Fed cut in 2026?") === true);
  check("BOTH state a year — deadlinesCompatible's job, not this one", compat(
    "Fed decision October 2026", "Fed decision October 2027") === true);
  check("both bare — two vague sides fall through", compat(
    "Fed Decision in October", "Fed meeting in October") === true);
}

console.log("\na year near a month belongs to that month, not to any digits");
{
  // "25bps" must not read as a year, and a year twelve words away must
  // not be attached to the month.
  check("bps is not a year", eventMonth("Hike by 25bps at their October meeting")?.year === null);
  check("an adjacent year attaches", eventMonth("at their October 2027 meeting")?.year === 2027);
}

console.log("\nthe soonest occurrence wraps across the year boundary");
{
  // Read in September, a bare "March" is next March, not last one.
  const march2027 = eventMonthsCompatible("Decision in March 2027", "Decision in March", { now: NOW });
  const march2026 = eventMonthsCompatible("Decision in March 2026", "Decision in March", { now: NOW });
  check("bare March resolves forward to 2027", march2027 === true);
  check("and so does not match March 2026", march2026 === false);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
