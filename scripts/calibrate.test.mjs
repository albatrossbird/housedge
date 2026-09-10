// The sampling rule is the correctness of the whole analysis, so it is
// pinned against the bias it exists to prevent.
import { feeOf, pickOnePerTicker, bucketize, simulate } from "../lib/calibrate.js";

let failures = 0;
const check = (name, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failures++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("fees come off the same curve the rest of the repo uses");
{
  check("0.80 at multiplier 1 is 1.12c", near(feeOf(0.8, 1), 0.0112));
  check("a multiplier of 0.5 halves it", near(feeOf(0.8, 0.5), 0.0056));
  check("the curve is symmetric about 0.5", near(feeOf(0.3, 1), feeOf(0.7, 1)));
  check("it collapses at the extremes", feeOf(0.99, 1) < 0.001);
}

console.log("\none observation per ticker, nearest the target moment");
{
  const rows = [
    { ticker: "A", secs_to_close: 200, yes_ask: 0.50 },
    { ticker: "A", secs_to_close: 95,  yes_ask: 0.70 },   // nearest 90
    { ticker: "A", secs_to_close: 20,  yes_ask: 0.90 },
    { ticker: "B", secs_to_close: 88,  yes_ask: 0.60 },
  ];
  const out = pickOnePerTicker(rows, 90);
  check("one row per ticker", out.length === 2);
  check("the nearest quote wins", out.find(r => r.ticker === "A").yes_ask === 0.70);

  // THE BIAS THIS EXISTS TO STOP. A market that chopped wrote five rows
  // and a quiet one wrote one. Counting rows would give the volatile
  // market five votes — and volatile markets are exactly the ones that
  // settle against their quote, so the gap would be manufactured.
  const choppy = [
    ...Array.from({ length: 5 }, (_, i) => ({ ticker: "LOUD", secs_to_close: 90 + i, yes_ask: 0.8 })),
    { ticker: "QUIET", secs_to_close: 90, yes_ask: 0.8 },
  ];
  check("a chatty market gets ONE vote, not five", pickOnePerTicker(choppy, 90).length === 2);

  check("a ticker with no settled result is dropped",
        pickOnePerTicker(rows, 90, { known: new Set(["B"]) }).length === 1);
  check("an unparseable secs_to_close is dropped",
        pickOnePerTicker([{ ticker: "C", secs_to_close: null }], 90).length === 0);
}

console.log("\ncalibration is asked of the ASK, not the midpoint");
{
  const obs = [
    { ticker: "w1", yes_ask: 0.90 }, { ticker: "w2", yes_ask: 0.92 },
    { ticker: "l1", yes_ask: 0.94 }, { ticker: "w3", yes_ask: 0.91 },
  ];
  const res = new Map([["w1", "yes"], ["w2", "yes"], ["w3", "yes"], ["l1", "no"]]);
  const [b] = bucketize(obs, res);
  check("one 5-cent bucket", b.n === 4 && near(b.lo, 0.90));
  check("hit rate is 3 of 4", near(b.hit, 0.75));
  check("gap is measured against the average ask", near(b.gap, 0.75 - 0.9175));
  check("a calibrated-looking price with a losing rate reports a NEGATIVE gap", b.gap < 0);
}

console.log("\nthe strategy: a high win rate is not an edge");
{
  const mult = 1;
  // Nine wins and one loss at a 0.92 ask: a 90% win rate on a market
  // priced at 92%. That is a LOSS, and the win rate alone hides it.
  const obs = [], res = new Map();
  for (let i = 0; i < 10; i++) {
    obs.push({ ticker: `t${i}`, yes_bid: 0.91, yes_ask: 0.92 });
    res.set(`t${i}`, i < 9 ? "yes" : "no");
  }
  const s = simulate(obs, res, { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("all ten entered", s.n === 10 && s.sides.yes === 10);
  check("win rate reads 90%", near(s.winRate, 0.9));
  check("breakeven is above it", s.breakeven > s.winRate);
  check("so the net EV is NEGATIVE despite a 90% win rate", s.netPer < 0);
  check("and the edge over price is negative", s.edgeOverPrice < 0);

  // Fees must be able to flip a marginally positive gross to a loss —
  // the case the whole exercise turns on.
  const obs2 = [], res2 = new Map();
  for (let i = 0; i < 100; i++) {
    obs2.push({ ticker: `u${i}`, yes_bid: 0.91, yes_ask: 0.92 });
    res2.set(`u${i}`, i < 93 ? "yes" : "no");
  }
  const s2 = simulate(obs2, res2, { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("93% at a 0.92 ask is gross-positive", s2.grossPer > 0);
  check("...and the fee eats most of it", s2.netPer < s2.grossPer);
}

console.log("\nthe NO side, and the filters");
{
  const mult = 1;
  // yes_bid 0.20 means the NO ask is 0.80 — inside the band, so this is
  // a NO entry, and it WINS when the market settles 'no'.
  const obs = [{ ticker: "n1", yes_bid: 0.20, yes_ask: 0.22 }];
  const s = simulate(obs, new Map([["n1", "no"]]), { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("a low yes_bid is a NO entry", s.sides.no === 1 && s.sides.yes === 0);
  check("priced at 1 - yes_bid", near(s.avgEntry, 0.80));
  check("and it won", s.wins === 1);

  const wide = simulate([{ ticker: "x", yes_bid: 0.60, yes_ask: 0.80 }],
    new Map([["x", "yes"]]), { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("a wide spread is filtered out", wide.n === 0);

  const mid = simulate([{ ticker: "y", yes_bid: 0.49, yes_ask: 0.50 }],
    new Map([["y", "yes"]]), { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("a coin-flip market is outside the band on both sides", mid.n === 0);

  // Number(null) is 0, and a fabricated zero would read as a free
  // option — the coercion this repo has been bitten by before.
  const absent = simulate([{ ticker: "z", yes_bid: null, yes_ask: null }],
    new Map([["z", "yes"]]), { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("an absent book is skipped, not read as 0", absent.n === 0);

  const live = simulate([{ ticker: "q", yes_bid: 0.79, yes_ask: 0.80 }],
    new Map(), { lo: 0.65, hi: 0.95, maxSpread: 0.03, mult });
  check("an unsettled market cannot be counted as a win", live.n === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
