// Kalshi's taker fee rounding (lib/fees.js), against the six live fills the
// trader measured on KXBTC15M on 2026-10-14 (one contract each, one level,
// fee_cost from GET /portfolio/fills on a direct account) and Kalshi's Fee
// Rounding page: the order's fee is rounded UP to the account's precision,
// $0.0001 for a direct member and $0.01 for an FCM-cleared one.
import { kalshiTakerFee, kalshiMakerFee, roundKalshiFee, KALSHI_FCM_FEE_PRECISION } from "../lib/fees.js";
import { kalshiOrderFee } from "../lib/m15RuleBook.js";

let failed = 0;
const eq = (got, want, what) => { if (Math.abs(got - want) < 1e-12) console.log(`  ok  ${what}`); else { failed++; console.error(`FAIL ${what}\n  got:  ${got}\n  want: ${want}`); } };

console.log("the trader's six fills: 0.07 x p x (1-p), rounded UP to $0.0001");
for (const [p, charged] of [[0.91, 0.0058], [0.88, 0.0074], [0.964, 0.0025], [0.79, 0.0117], [0.97, 0.0021], [0.85, 0.0090]])
  eq(kalshiTakerFee(p, 1, 1), charged, `1 at ${p} charged ${charged}`);

console.log("per order, once");
eq(kalshiTakerFee(0.91, 10, 1), 0.0574, "10 at 0.91: 0.05733 -> 0.0574 (not 10 x 0.0058 = 0.058)");
eq(kalshiTakerFee(0.88, 100, 1), 0.7392, "an exact multiple stays put: 100 at 0.88 is $0.7392, not a step more");
eq(kalshiOrderFee([[0.91, 5], [0.92, 5]], 1), 0.0545, "a fill across two levels is summed and rounded once: 0.028665 + 0.025760 = 0.054425 -> 0.0545");
eq(kalshiTakerFee(0.5, 1, 0.5), 0.0088, "the series multiplier applies before rounding: 0.00875 -> 0.0088");

console.log("an FCM-cleared account rounds to the cent, which the site still prices");
eq(kalshiTakerFee(0.91, 1, 1, KALSHI_FCM_FEE_PRECISION), 0.01, "1 at 0.91 -> 1c");
eq(kalshiTakerFee(0.79, 1, 1, KALSHI_FCM_FEE_PRECISION), 0.02, "1 at 0.79 (0.011613) -> 2c");

console.log("edges");
eq(roundKalshiFee(0), 0, "no fee is no fee");
eq(kalshiTakerFee(1, 5, 1), 0, "a price of 1 charges nothing");
eq(kalshiMakerFee(0.5, 10, 1, "quadratic"), 0, "makers pay nothing on fee_type quadratic");
eq(kalshiMakerFee(0.5, 1, 1, "quadratic_with_maker_fees"), 0.0044, "maker fee rounds the same way: 0.004375 -> 0.0044");

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
