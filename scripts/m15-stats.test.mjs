// lib/m15Stats.js — priced vs won, EV, Sharpe and Kelly, against numbers
// computed independently (Python, by hand) rather than read off the code.
//
// Pinned here:
//   1. The Wilson interval matches the textbook values.
//   2. Kelly for a $1 binary bought at all-in cost c is (q - c)/(1 - c),
//      and is reported at the low end of the win-rate range as well.
//   3. "needs" (breakeven) includes Kalshi's fee, not just the price.
//   4. EV's range resamples whole days: it stays inside the best and worst
//      day, and it is the same on every run.
//   5. Sharpe is daily mean/sd, annualised by sqrt(trading days).
//   6. Calibration splits by entry price band.
import { wilson, kelly, dayBootstrap, ruleStats, calibration } from "../lib/m15Stats.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

console.log("intervals and Kelly");
{
  const w = wilson(85, 100);
  ok(near(w.lo, 0.7671627) && near(w.hi, 0.9069410), "Wilson 85/100 = [0.7672, 0.9069]", JSON.stringify(w));
  ok(wilson(0, 0) === null, "no trials, no interval");
  ok(near(kelly(0.9, 0.85), 1 / 3), "Kelly: 90% to win $1 at 85c all-in = (0.90 - 0.85)/0.15 = 1/3 of bankroll");
  ok(kelly(0.8, 0.85) < 0, "a win rate under the cost is a negative Kelly: do not bet");
  ok(kelly(0.9, 1) === null && kelly(0.9, 0) === null, "no Kelly at a degenerate price");
}

// Three days of ten trades each: 10 contracts at 0.80 with a 12c fee per
// order (all-in 0.812). Days one and two win 9 of 10, day three 7 of 10.
const D = ["2026-10-01", "2026-10-02", "2026-10-03"];
const trades = [];
D.forEach((d, i) => {
  const wins = i < 2 ? 9 : 7;
  for (let j = 0; j < 10; j++) {
    const won = j < wins;
    trades.push({ close: Date.parse(`${d}T12:00:00Z`) + j * 900000, entry: 0.80, qty: 10, entryFee: 0.12, won,
      pnl: (won ? 10 : 0) - 8 - 0.12 });
  }
});

console.log("one rule's numbers");
{
  const R = ruleStats(trades, { daysPerYear: 365 });
  ok(R.n === 30 && near(R.winRate, 25 / 30), "won 25 of 30", JSON.stringify({ n: R.n, q: R.winRate }));
  ok(near(R.priced, 0.80) && near(R.breakeven, 0.812), "priced 80%, needs 81.2% once the fee is in");
  ok(near(R.edgePts, 25 / 30 - 0.812), "edge = won - needs", String(R.edgePts));
  ok(near(R.evPerContract, 6.4 / 300), "EV per contract: (8.80 + 8.80 - 11.20) / 300 contracts", String(R.evPerContract));
  ok(near(R.sharpeDaily, 0.1847521) && near(R.sharpeAnnual, 3.5296836), "Sharpe: daily 0.185, x sqrt(365) = 3.53", JSON.stringify([R.sharpeDaily, R.sharpeAnnual]));
  ok(near(R.kelly, 0.1134752), "Kelly at the estimate: 11.3% of bankroll", String(R.kelly));
  ok(R.winLow <= wilson(25, 30).lo + 1e-12 && R.kellyLow < 0, "at the low end of the win-rate range the bet disappears", JSON.stringify({ lo: R.winLow, k: R.kellyLow }));
  const dayEv = [8.8 / 100, 8.8 / 100, -11.2 / 100];
  ok(R.evBoot && R.evBoot.lo >= Math.min(...dayEv) - 1e-12 && R.evBoot.hi <= Math.max(...dayEv) + 1e-12 && R.evBoot.lo < R.evBoot.hi,
    "EV's by-day range sits between the worst and best day", JSON.stringify(R.evBoot));
  const again = ruleStats(trades, { daysPerYear: 365 });
  ok(again.evBoot.lo === R.evBoot.lo && again.evBoot.hi === R.evBoot.hi, "and is identical on a second run");
  ok(near(ruleStats(trades, { daysPerYear: 252 }).sharpeAnnual, 0.1847521 * Math.sqrt(252)), "252 trading days for a weekday market");
  ok(dayBootstrap(trades.slice(0, 10), ts => ts.length) === null, "one day cannot be resampled by day");
  ok(ruleStats([]).n === 0, "no trades, no numbers");
}

console.log("calibration");
{
  const mixed = [
    { close: 0, entry: 0.65, qty: 10, entryFee: 0.16, won: true, pnl: 0 },
    { close: 0, entry: 0.66, qty: 10, entryFee: 0.16, won: false, pnl: 0 },
    { close: 0, entry: 0.85, qty: 10, entryFee: 0.09, won: true, pnl: 0 },
  ];
  const c = calibration(mixed);
  ok(c.length === 2 && c[0].n === 2 && near(c[0].won, 0.5) && near(c[0].priced, 0.655) && c[1].n === 1 && c[1].won === 1,
    "entries split into price bands, each priced against how often it won", JSON.stringify(c));
  ok(near(c[1].breakeven, 0.859), "each band's breakeven carries its fee", String(c[1].breakeven));
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
