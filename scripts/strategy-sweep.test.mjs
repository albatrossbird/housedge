import { collectEntries, score, realWin, mulberry32, simulatedWin,
         nullDistribution, quantile, pValue } from "../lib/strategySweep.js";

let failures = 0;
const check = (n, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); if (!ok) failures++; };
const near = (a, b, e) => Math.abs(a - b) < e;

const spec = (o = {}) => ({ entry: { side: "either", ...o }, exit: "settlement" });
const q = (ticker, bid, ask, secs = 60) =>
  ({ ticker, yes_bid: bid, yes_ask: ask, secs_to_close: secs });

console.log("entries are collected once and scored many times");
{
  const obs = [q("A", 0.90, 0.92), q("B", 0.60, 0.62)];
  const specs = [spec({ price: { min: 0.85, max: 0.95 } }), spec({ price: { min: 0.5, max: 0.7 } })];
  const per = collectEntries(obs, specs);
  check("the favourite filter took one entry", per[0].length === 1);
  check("...at the ask, not the bid", per[0][0].price === 0.92);
  check("the mid-band filter took the other", per[1].length === 1 && per[1][0].ticker === "B");
  // impliedYes is what makes one draw per market score both sides.
  check("a yes fill implies the ask", per[0][0].impliedYes === 0.92);
}

console.log("\na no fill is the complement, and implies the BID");
{
  const per = collectEntries([q("A", 0.10, 0.12)], [spec({ side: "no", price: { min: 0.8, max: 0.95 } })]);
  check("no-ask is 1 - yes_bid", near(per[0][0].price, 0.90, 1e-9));
  check("...and its implied yes is the bid", near(per[0][0].impliedYes, 0.10, 1e-9));
}

console.log("\none market resolves once: yes and no cannot both win");
{
  const per = [[{ ticker: "A", side: "yes", price: 0.6, impliedYes: 0.6 },
                { ticker: "A", side: "no",  price: 0.4, impliedYes: 0.6 }]];
  let both = 0, neither = 0;
  const rand = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const won = simulatedWin(rand, ["A"]);
    const y = won(per[0][0]), n = won(per[0][1]);
    if (y && n) both++;
    if (!y && !n) neither++;
  }
  check("never both", both === 0);
  check("never neither", neither === 0);
}

console.log("\nthe null is CALIBRATED: edge over price must centre on zero");
{
  // If this drifts, every correction built on it is decorative. Ten
  // markets at assorted prices, scored across many simulated worlds.
  const entries = [];
  for (let i = 0; i < 10; i++) {
    const p = 0.1 + i * 0.08;
    entries.push({ ticker: `T${i}`, side: "yes", price: p, impliedYes: p });
  }
  const tickers = entries.map(e => e.ticker);
  const rand = mulberry32(99);
  let sum = 0;
  const draws = 4000;
  for (let d = 0; d < draws; d++) {
    sum += score(entries, 1, simulatedWin(rand, tickers)).edgeOverPrice;
  }
  const mean = sum / draws;
  check(`mean edge ${(100 * mean).toFixed(3)}pt is within 0.5pt of zero`, Math.abs(mean) < 0.005);
}

console.log("\nthe null prices the cost of trying many things");
{
  // Twenty strategies over the same markets. The best of twenty on pure
  // noise must beat the best of one — that gap IS the multiplicity
  // correction, and a sweep that reported the same bar for both would
  // be the bug this file exists to prevent.
  const mk = k => Array.from({ length: 40 }, (_, i) =>
    ({ ticker: `T${i}`, side: "yes", price: 0.5 + ((i + k) % 7) * 0.05,
       impliedYes: 0.5 + ((i + k) % 7) * 0.05 }));
  const one = nullDistribution([mk(0)], 1, { draws: 600, seed: 5 });
  const twenty = nullDistribution(Array.from({ length: 20 }, (_, k) => mk(k)), 1, { draws: 600, seed: 5 });
  const q95one = quantile(one.bestEdge, 0.95), q95twenty = quantile(twenty.bestEdge, 0.95);
  check(`best-of-20 noise (${(100 * q95twenty).toFixed(2)}pt) exceeds best-of-1 (${(100 * q95one).toFixed(2)}pt)`,
        q95twenty > q95one);
}

console.log("\nthe p-value is a share of simulated worlds, and never zero");
{
  const dist = [0.01, 0.02, 0.03, 0.04, 0.05];
  check("an unremarkable result is not significant", pValue(dist, 0.02) > 0.4);
  check("a result beyond every draw is still bounded away from 0",
        pValue(dist, 0.99) === 1 / 6);
  check("...because 0 would claim more certainty than draws allow",
        pValue(dist, 999) > 0);
}

console.log("\nthe same seed gives the same answer");
{
  const e = [{ ticker: "A", side: "yes", price: 0.7, impliedYes: 0.7 }];
  const a = nullDistribution([e], 1, { draws: 50, seed: 42 });
  const b = nullDistribution([e], 1, { draws: 50, seed: 42 });
  check("reproducible", JSON.stringify(a.bestEdge) === JSON.stringify(b.bestEdge));
  const c = nullDistribution([e], 1, { draws: 50, seed: 43 });
  check("and a different seed is a different null",
        JSON.stringify(a.bestEdge) !== JSON.stringify(c.bestEdge));
}

console.log("\nreal scoring still agrees with the outcome map");
{
  const resultOf = new Map([["A", "yes"], ["B", "no"]]);
  const entries = [{ ticker: "A", side: "yes", price: 0.5, impliedYes: 0.5 },
                   { ticker: "B", side: "yes", price: 0.5, impliedYes: 0.5 }];
  const s = score(entries, 1, realWin(resultOf), t => (t === "A" ? "2026-09-16" : "2026-09-17"));
  check("one win of two", s.wins === 1 && s.n === 2);
  check("two distinct days counted", s.days === 2);
  // At 50c with a fee both ways, a coin flip loses exactly the fee.
  check("a 50/50 at 50c nets the fee, negative", s.netPer < 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
