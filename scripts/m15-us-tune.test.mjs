// lib/m15UsTune.js — Kalshi decides, Polymarket US fills; the pre-committed
// choice; the day split. Hand-built windows, every number worked out.
//
// Pinned here:
//   1. The decision (moment and side) is Kalshi's; the price and size are the
//      .us book's at that instant; the fill is the .us book DELAY ms later.
//   2. A .us book older than 2s, a .us price above the cap, or no .us depth
//      within 1c skips the window rather than inventing a price.
//   3. +1c is a limit 1c above the .us price seen, never above the cap, and
//      pays the walked price; NO walks the .us bids mirrored.
//   4. The choice is the highest score; a variant with no score cannot win.
//   5. The days split in half, earlier half tunes; an explicit date wins.
import { kalshiDecidesUs, chooseVariant, splitDays } from "../lib/m15UsTune.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

const C = Date.parse("2026-10-01T12:15:00Z");
const market = { ticker: "KXBTC15M-W", close: C, result: "yes" };
const rule = [["r", { entry: { side: "favourite", secsMin: 15, secsMax: 45, priceMin: 0.75, priceMax: 0.97, maxSpread: 0.03 } }]];
const row = (msBefore, bid, ask, bidD1 = 50, askD1 = 50) => ({ t: C - msBefore, secs: msBefore / 1000, bid, ask, bidD1, askD1 });
const F = (msBefore, bids, asks) => ({ k: "F", x: C - msBefore, L: [bids, asks] });
const win = events => ({ ticker: market.ticker, close: C, finalT: C - 130000, events });

console.log("Kalshi decides, .us fills");
{
  // Kalshi 88/89 at 40s: YES at 0.89. The .us book 0.5s earlier is 87/88.5
  // with 20 offered at 0.885 -> the order is 10 at 0.885. 50ms after the
  // decision the 0.885 offer is gone (ask 0.895, then 0.90).
  //   at price seen: limit 0.885 -> nothing at +100ms or +250ms
  //   +1c:           limit 0.895 -> 10 at 0.895
  const kRows = [row(60000, 0.70, 0.71), row(40000, 0.88, 0.89)];
  const usRows = [row(40500, 0.87, 0.885, 50, 20)];
  const ws = win([F(40500, [[0.87, 50]], [[0.885, 20], [0.90, 30]]), F(39950, [[0.87, 50]], [[0.895, 30], [0.90, 30]])]);
  const r = kalshiDecidesUs({ market, kRows, usRows, ws, strategies: rule, size: 10 }).r;
  ok(r.seen[100].n === 0 && r.seen[250].n === 0, "at the .us price seen: the offer is gone, a miss", JSON.stringify(r.seen));
  ok(r["+1c"][100].n === 10 && near(r["+1c"][100].cost, 8.95) && r["+1c"][100].side === "yes", "+1c: 10 at 0.895 on the .us book", JSON.stringify(r["+1c"][100]));
  ok(r["+1c"][100].qty === 10 && near(r["+1c"][100].price, 0.885), "priced and sized off the .us book at the decision, not Kalshi's 0.89", JSON.stringify(r["+1c"][100]));
  ok(r["+1c"][100].fills.length === 1 && r["+1c"][100].fills[0][0] === 0.895, "the fills are kept for the per-fill .us fee", JSON.stringify(r["+1c"][100].fills));

  // The .us offer within 1c holds 4: the order is 4, not 10.
  const thin = kalshiDecidesUs({ market, kRows, usRows: [row(40500, 0.87, 0.885, 50, 4)], ws, strategies: rule, size: 10 }).r;
  ok(thin["+1c"][100].qty === 4 && thin["+1c"][100].n === 4, "size is the .us depth within 1c when that is under the target", JSON.stringify(thin["+1c"][100]));
}

console.log("skips, the cap, NO");
{
  const kRows = [row(40000, 0.88, 0.89)];
  const ws = win([F(45000, [[0.87, 50]], [[0.885, 20]])]);
  const stale = kalshiDecidesUs({ market, kRows, usRows: [row(42500, 0.87, 0.885)], ws, strategies: rule }).r;
  ok(stale.skip === "stale .us book", "a .us book 2.5s old is not used", JSON.stringify(stale));
  const fresh = kalshiDecidesUs({ market, kRows, usRows: [row(41500, 0.87, 0.885)], ws, strategies: rule }).r;
  ok(!fresh.skip, "1.5s old is", JSON.stringify(fresh));
  const cap = kalshiDecidesUs({ market, kRows, usRows: [row(40500, 0.96, 0.975)], ws, strategies: rule }).r;
  ok(cap.skip === ".us above the cap", ".us offering YES at 0.975 against a 0.97 cap: skipped", JSON.stringify(cap));
  const dry = kalshiDecidesUs({ market, kRows, usRows: [row(40500, 0.87, 0.885, 50, 0)], ws, strategies: rule }).r;
  ok(dry.skip === "no .us depth", "nothing offered within 1c on .us: skipped", JSON.stringify(dry));
  // .us at 0.965: +1c may only go to the 0.97 cap.
  const near97 = kalshiDecidesUs({ market, kRows, usRows: [row(40500, 0.955, 0.965)], ws: win([F(40500, [[0.955, 50]], [[0.965, 5], [0.97, 5], [0.975, 50]]), F(39990, [[0.955, 50]], [[0.97, 5], [0.975, 50]])]), strategies: rule, size: 10 }).r;
  ok(near97["+1c"][100].n === 5 && near(near97["+1c"][100].cost, 4.85), "+1c from 0.965 stops at the 0.97 cap: 5 at 0.97, not the 0.975 above", JSON.stringify(near97["+1c"][100]));
  // Kalshi 10/12: NO favourite at 0.90. .us 11/13: NO at 0.89, 30 bid within 1c.
  // The .us 0.11 bid empties; the next is 0.10 = NO at 0.90 -> +1c fills there.
  const no = kalshiDecidesUs({ market, kRows: [row(40000, 0.10, 0.12)], usRows: [row(40500, 0.11, 0.13, 30, 50)],
    ws: win([F(40500, [[0.11, 10], [0.10, 20]], [[0.13, 50]]), F(39950, [[0.10, 20]], [[0.13, 50]])]), strategies: rule, size: 10 }).r;
  ok(no.seen[100].n === 0 && no["+1c"][100].n === 10 && near(no["+1c"][100].cost, 9.0) && no["+1c"][100].side === "no", "NO walks the .us bids mirrored: 0.10 bid = NO at 0.90", JSON.stringify(no));
  const none = kalshiDecidesUs({ market, kRows: [row(40000, 0.40, 0.42)], usRows: [row(40500, 0.40, 0.42)], ws, strategies: rule }).r;
  ok(none === null, "no Kalshi decision: null, not a miss");
  const late = kalshiDecidesUs({ market, kRows: [row(16000, 0.88, 0.89)], usRows: [row(16100, 0.87, 0.885)], ws: win([F(16100, [[0.87, 50]], [[0.885, 20]])]),
    strategies: [["r", { entry: { ...rule[0][1].entry, secsMin: 0 } }]], delays: [250] }).r;
  ok(late.seen[250].n === 10, "16s out + 250ms is still before the close", JSON.stringify(late.seen));
}

console.log("choosing and splitting");
{
  const v = [{ label: "a", score: 1.2 }, { label: "b", score: NaN }, { label: "c", score: 2.1 }, { label: "d", score: 2.1 }, { label: "e", score: -Infinity }];
  ok(chooseVariant(v).label === "c", "highest score wins; NaN never does; ties go to the earlier variant");
  ok(chooseVariant([{ label: "x", score: NaN }]) === null, "nothing scorable: nothing chosen");
  const days = ["2026-10-03", "2026-10-01", "2026-10-02", "2026-10-02", "2026-10-04", "2026-10-05"];
  const s = splitDays(days);
  ok(s.tune.join() === "2026-10-01,2026-10-02" && s.test.join() === "2026-10-03,2026-10-04,2026-10-05", "five distinct days: the first two tune, the last three test", JSON.stringify(s));
  const e = splitDays(days, "2026-10-04");
  ok(e.tune.length === 3 && e.test.join() === "2026-10-04,2026-10-05", "an explicit split date is the first test day", JSON.stringify(e));
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
