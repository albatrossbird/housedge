// Kalshi's liquidity-incentive scoring (lib/lip.js), worked by hand from
// the help page's description. The book and program shapes are the live
// ones (REST orderbook_fp.yes_dollars / no_dollars as [price, size]
// strings; /incentive_programs' period_reward in centi-cents), copied
// 2026-11-16.

import { sideScore, quoteReward, supplyReward, poolPerDay } from "../lib/lip.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log("one side");
{
  // Target 1,000 so a fifth is 200. Walking down: 100 at 0.40 (100), 150 at
  // 0.39 (250 >= 200) -> the reference price is 0.39.
  const yes = [["0.3000", "1000.00"], ["0.3800", "300.00"], ["0.3900", "150.00"], ["0.4000", "100.00"]];
  const s = sideScore(yes, { target: 1000, discount: 0.5 });
  ok(s.ref === 0.39, `the reference price is the first level holding a fifth of the target (${s.ref})`);
  // 100 + 150 at full size, 300 one tick away at 0.5, 1000 nine ticks away at 0.5^9.
  ok(near(s.score, 100 + 150 + 300 * 0.5 + 1000 * 0.5 ** 9), `orders behind it are discounted by the tick (${s.score.toFixed(3)})`);
  ok(s.size === 1550, "plain resting size is kept apart from the score");
  ok(near(sideScore(yes, { target: 1000, discount: 1 }).score, 1550), "a discount factor of 1 is no penalty");
  ok(sideScore([["0.4000", "50.00"]], { target: 1000, discount: 0.5 }).ref === null, "a side that never holds a fifth of the target has no reference price");
  ok(sideScore([], { target: 1000, discount: 0.5 }).ref === null, "an empty side has none");
  ok(sideScore([["0.4000", "100.00"], ["0.3900", "150.00"]], { target: 1000, discount: 0.5 }).ref === 0.39, "levels may arrive in any order");
}

console.log("a quote on both sides");
{
  const yes = [["0.3800", "300.00"], ["0.3900", "150.00"], ["0.4000", "100.00"], ["0.3000", "1000.00"]];
  const no = [["0.5500", "400.00"], ["0.5800", "800.00"]];   // best NO bid 0.58 -> YES ask 0.42
  // NO side: 800 at 0.58 >= 200 -> ref 0.58; score 800 + 400 x 0.5^3 = 850; size 1,200.
  const q = quoteReward({ yes, no, target: 1000, discount: 0.5, poolPerDay: 10, capital: 200 });
  ok(q.refYes === 0.39 && q.refNo === 0.58, "it joins each side at that side's reference price");
  ok(q.S === 206 && near(q.cost, 206 * 0.97), `$200 buys ${q.S} contracts a side at 0.39 + 0.58`);
  const yScore = 250 + 150 + 1000 * 0.5 ** 9, wantY = 206 / (yScore + 206), wantN = 206 / (850 + 206);
  ok(near(q.shareYes, wantY) && near(q.shareNo, wantN), `our share of a side is our size over everyone's score (${(q.shareYes * 100).toFixed(1)}% / ${(q.shareNo * 100).toFixed(1)}%)`);
  ok(q.counts.lenient === true && near(q.perDay.lenient, 10 * (wantY + wantN) / 2), `the pool pays the average of the two shares ($${q.perDay.lenient.toFixed(2)} of $10)`);
  ok(q.counts.strict === false && q.perDay.strict === 0, "by score rather than size the yes side is under target, and nothing is paid");
}

console.log("when a snapshot cannot count");
{
  // The live KXNVDACEO-29JAN-MADI book of 2026-11-16: NO bids up to 0.99,
  // no YES bid at all (the market is at 0/1c).
  const no = [["0.0100", "41333.00"], ["0.9000", "1453.10"], ["0.9500", "606.00"], ["0.9800", "36261.00"], ["0.9900", "122353.72"]];
  const q = quoteReward({ yes: [], no, target: 1000, discount: 0.5, poolPerDay: 71.43 });
  ok(q.S === 0 && q.perDay.lenient === 0 && /yes side/.test(q.why), `a market with one empty side pays nothing, and says why (${q.why})`);
  const thin = quoteReward({ yes: [["0.4000", "250.00"]], no: [["0.5800", "250.00"]], target: 1000, discount: 0.5, poolPerDay: 10 });
  ok(thin.S === 204 && thin.counts.lenient === false && thin.perDay.lenient === 0 && thin.shareYes > 0.4, "a quote that still leaves a side under target earns nothing, whatever its share");
  const big = quoteReward({ yes: [["0.4000", "250.00"]], no: [["0.5800", "250.00"]], target: 1000, discount: 0.5, poolPerDay: 10, capital: 800 });
  ok(big.counts.lenient === true && big.perDay.lenient > 7, "enough size to reach the target ourselves makes it count");
  ok(quoteReward({ yes: [["0.4000", "250.00"]], no: [["0.5800", "250.00"]], target: 1000, discount: 0.5, poolPerDay: 10, capital: 0.5 }).why === "capital buys under one contract a side", "too little capital is named");
}

console.log("supplying a thin side");
{
  // YES side nearly empty (40 at 0.03), NO side deep at 0.95. Target 1,000.
  const yes = [["0.0300", "40.00"]], no = [["0.9500", "3000.00"], ["0.9400", "500.00"]];
  ok(quoteReward({ yes, no, target: 1000, discount: 0.5, poolPerDay: 14 }).perDay.lenient === 0, "the join-only quote earns nothing here");
  const q = supplyReward({ yes, no, target: 1000, discount: 0.5, poolPerDay: 14, capital: 200 });
  // YES needs 960 more at 0.03 = $28.80; the NO side needs nothing. The
  // other $171.20 buys floor(171.2 / 0.98) = 174 more a side.
  ok(q.priceYes === 0.03 && q.priceNo === 0.95 && q.sizeYes === 960 + 174 && q.sizeNo === 174, `it rests at the thin side's best bid and fills it to the target (${q.sizeYes} yes at ${q.priceYes}, ${q.sizeNo} no at ${q.priceNo})`);
  ok(near(q.cost, 1134 * 0.03 + 174 * 0.95), `for $${q.cost.toFixed(2)}`);
  ok(near(q.shareYes, 1134 / 1174) && near(q.shareNo, 174 / (3000 + 500 * 0.5 + 174)), `and scores most of that side (${(100 * q.shareYes).toFixed(1)}% / ${(100 * q.shareNo).toFixed(1)}%)`);
  ok(q.counts.lenient && near(q.perDay.lenient, 14 * (1134 / 1174 + 174 / 3424) / 2), `so the pool pays $${q.perDay.lenient.toFixed(2)} of $14`);
  ok(q.supplied === 1, "one side was supplied");
  // An empty side takes its price from the other side: NO bid 0.95 -> YES ask 0.05 -> our YES bid 0.04.
  const e = supplyReward({ yes: [], no, target: 1000, discount: 0.5, poolPerDay: 14, capital: 200 });
  ok(e.priceYes === 0.04 && e.sizeYes >= 1000, `an empty side is bid one tick under the implied ask (${e.priceYes})`);
  // A market at 99c has no room for a YES bid at all.
  ok(/no price a bid could rest at/.test(supplyReward({ yes: [], no: [["0.9900", "5000.00"]], target: 1000, discount: 0.5, poolPerDay: 14 }).why), "a side with no possible price is refused");
  ok(/over the capital/.test(supplyReward({ yes: [["0.4000", "10.00"]], no: [["0.5800", "3000.00"]], target: 1000, discount: 0.5, poolPerDay: 14, capital: 200 }).why), "a thin side at 40c costs more than the capital to fill, and says so");
  // On a book with both references it is the join quote, with the same shares.
  const yes2 = [["0.3800", "300.00"], ["0.3900", "150.00"], ["0.4000", "100.00"], ["0.3000", "1000.00"]], no2 = [["0.5500", "400.00"], ["0.5800", "800.00"]];
  const a = quoteReward({ yes: yes2, no: no2, target: 1000, discount: 0.5, poolPerDay: 10 }), b = supplyReward({ yes: yes2, no: no2, target: 1000, discount: 0.5, poolPerDay: 10 });
  ok(b.sizeYes === a.S && near(b.shareYes, a.shareYes) && near(b.perDay.lenient, a.perDay.lenient), "where both sides already have a reference price the two quotes agree");
}

console.log("the pool");
{
  const p = { period_reward: 5000000, start_date: "2026-11-15T05:00:00Z", end_date: "2026-11-22T05:00:00Z" };
  ok(near(poolPerDay(p), 500 / 7), `5,000,000 centi-cents over 7 days is $${poolPerDay(p).toFixed(2)} a day`);
  ok(poolPerDay({ period_reward: 1, start_date: "2026-11-15T05:00:00Z", end_date: "2026-11-15T05:00:00Z" }) === 0, "a zero-length period pays nothing rather than infinity");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
