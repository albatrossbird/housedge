// lib/bigPrint.js: calibration of big prints and following them late.
import { windowRecords, newAgg, add, summary, bandOf, SIZE_BANDS } from "../lib/bigPrint.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const noFee = () => 0;
const close = 1000000;

console.log("calibration");
{
  const { rows } = windowRecords([
    { x: close - 30000, n: 5, side: "yes", paid: 0.8 },
    { x: close - 20000, n: 5, side: "no", paid: 0.25 },
    { x: close + 1, n: 5, side: "yes", paid: 0.9 },          // after the close: not a trade on the window
  ], { close, result: "yes", fee: noFee });
  ok(rows.length === 2, "a trade at or after the close is dropped", rows.length);
  ok(near(rows[0].edge, 0.2) && rows[0].won === 1, "a winning taker's edge is 1 - paid", rows[0].edge);
  ok(near(rows[1].edge, -0.25) && rows[1].won === 0, "a losing taker's edge is -paid", rows[1].edge);
  ok(near(rows[0].secs, 30), "time to close in seconds", rows[0].secs);
}
{
  const { rows } = windowRecords([{ x: close - 1000, n: 1, side: "yes", paid: 0.5 }],
    { close, result: "yes", fee: (p, q) => Math.ceil(0.07 * q * p * (1 - p) * 100) / 100 });
  ok(near(rows[0].edge, 0.5 - 0.02), "a 1-contract order pays its fee rounded up to the cent (1.75c -> 2c)", rows[0].edge);
}

console.log("following a big print");
{
  const trades = [
    { x: close - 60000, n: 5000, side: "yes", paid: 0.60 },   // the big print
    { x: close - 59900, n: 10, side: "yes", paid: 0.61 },     // +100ms
    { x: close - 59500, n: 10, side: "no", paid: 0.30 },      // other side: never the follower's price
    { x: close - 59000, n: 10, side: "yes", paid: 0.64 },     // +1000ms
    { x: close - 10000, n: 10, side: "yes", paid: 0.90 },     // +50s
  ];
  const { follows } = windowRecords(trades, { close, result: "yes", fee: noFee });
  const at = L => follows.find(f => f.delay === L);
  ok(near(at(0).edge, 0.40), "at its own price: 1 - 0.60", at(0).edge);
  ok(near(at(250).edge, 1 - 0.64), "250ms later: the first same-side taker at or after +250ms (0.64), not the +100ms one", at(250).edge);
  ok(near(at(1000).edge, 1 - 0.64), "1000ms later: 0.64", at(1000).edge);
  ok(near(at(5000).edge, 1 - 0.90) && near(at(15000).edge, 1 - 0.90), "5s and 15s later: the next same-side taker, 0.90", at(15000).edge);
  ok(follows.length === 5, "small trades are not followed", follows.length);
}
{
  const { follows } = windowRecords([{ x: close - 2000, n: 20000, side: "no", paid: 0.7 }], { close, result: "yes", fee: noFee });
  const late = follows.find(f => f.delay === 1000);
  ok(late.filled === false && late.edge === null, "nothing traded after it before the close: not filled, not a zero");
  ok(near(follows.find(f => f.delay === 0).edge, -0.7), "a losing big print followed at its price loses what it paid");
}

console.log("aggregation by day");
{
  const agg = newAgg();
  add(agg, "k", "d1", 0.10, { won: 1, paid: 0.9, ctrs: 10 });
  add(agg, "k", "d1", -0.90, { won: 0, paid: 0.9, ctrs: 10 });
  add(agg, "k", "d2", 0.10, { won: 1, paid: 0.9, ctrs: 10 });
  const s = summary(agg.get("k"));
  ok(s.n === 3 && s.days === 2 && near(s.edge, (0.1 - 0.9 + 0.1) / 3), "edge is per trade over all trades", s.edge);
  // day means -0.4 and 0.1 -> mean -0.15, sd 0.3536, se 0.25, t -0.6
  ok(s.t === null, "two days give no t: under three it is noise", s.t);
  add(agg, "k", "d3", 0.10, { won: 1, paid: 0.9, ctrs: 10 });
  // day means -0.4, 0.1, 0.1 -> mean -0.0667, sd 0.2887, se 0.1667, t -0.4
  ok(near(summary(agg.get("k")).t, -0.4), "t is over DAY means, not trades", summary(agg.get("k")).t);
  ok(summary(agg.get("missing")) === null, "an empty band is null, not zero");
  ok(bandOf(SIZE_BANDS, 99) === 0 && bandOf(SIZE_BANDS, 100) === 1 && bandOf(SIZE_BANDS, 25000) === 3, "size bands");
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
