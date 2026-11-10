// lib/m15TimeOfDay.js: New York hours across DST, and the paired-day test.
import { etParts, blockOf, pairedDayDiff, verdict, TOD_TESTS } from "../lib/m15TimeOfDay.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// 2026-10-30 is EDT (UTC-4); 2026-11-02 is EST (UTC-5): clocks fell back 11-01.
ok(etParts(Date.parse("2026-10-30T20:30:00Z")).hour === 16 && blockOf(Date.parse("2026-10-30T20:30:00Z")) === 16, "EDT: 20:30 UTC is 16:30 in New York, block 16-20");
ok(etParts(Date.parse("2026-11-02T20:30:00Z")).hour === 15 && blockOf(Date.parse("2026-11-02T20:30:00Z")) === 12, "EST: the same UTC time is 15:30 after the clocks change");
ok(blockOf(Date.parse("2026-11-03T04:59:00Z")) === 20 && blockOf(Date.parse("2026-11-03T05:00:00Z")) === 0, "midnight in New York, not in UTC, starts block 0");
ok(etParts(Date.parse("2026-11-08T03:00:00Z")).weekend && !etParts(Date.parse("2026-11-07T03:00:00Z")).weekend, "the weekend is New York's: 03:00 UTC Sunday is Saturday evening, 03:00 UTC Saturday is Friday evening");

const r = (day, b, pnl) => ({ day, b, pnl, ctrs: 10 });
// Every day: inside earns 1c a contract more than outside, with some noise.
const rows = [];
for (let d = 1; d <= 20; d++) {
  const day = `2026-07-${String(d).padStart(2, "0")}`;
  rows.push(r(day, 16, 0.1 + (d % 3) * 0.01), r(day, 0, 0 + (d % 2) * 0.01), r(day, 4, 0.02));
}
const res = pairedDayDiff(rows, x => x.b === 16);
ok(res.days === 20 && res.diff > 0.008 && res.diff < 0.012 && res.t > 5, "a block that beats the rest on every day reads as a large positive t", JSON.stringify(res));
ok(verdict(res, +1) === "PASS" && verdict(res, -1) === "FAIL", "a result passes only in the predicted direction");
const lop = pairedDayDiff([...rows, r("2026-08-01", 16, 5)], x => x.b === 16);
ok(lop.days === 20, "a day with trades on only one side of the split is left out of the pairing");
ok(pairedDayDiff([r("2026-07-01", 16, 1), r("2026-07-01", 0, 0)], x => x.b === 16).t === null, "one day is not enough for a t");
ok(TOD_TESTS.p75[0].sign === -1 && TOD_TESTS.sharp[0].sign === 1 && TOD_TESTS.p75[0].inside(16) && !TOD_TESTS.p75[0].inside(12), "the hypotheses are the trader's: p75 worse at 16-20h, sharp-move better");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall time-of-day checks passed");
