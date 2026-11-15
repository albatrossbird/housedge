// The volatility flag (lib/volFlag.js, docs/research/vol-flag-plan.md).
// Market fields are the live /markets shape (floor_strike as a number,
// expiration_value as a string), as in the KXBTC15M sample copied
// 2026-11-14 into scripts/ladder.test.mjs. Returns and trades are
// synthetic: this is arithmetic.

import { returnsFromSettlements, trailingVol, quantile, welchT, scoreFlag } from "../lib/volFlag.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

console.log("returns from settlements");
const live = { ticker: "KXBTC15M-26NOV132345-45", floor_strike: 66836.28, expiration_value: "67048.42", close_time: "2026-11-14T04:45:00Z" };
const r = returnsFromSettlements([live, { ...live, expiration_value: "" }, { ...live, floor_strike: null }]);
ok(r.length === 1, "a market missing either price is skipped");
ok(Math.abs(r[0].ret - Math.log(67048.42 / 66836.28)) < 1e-12, "the return is ln(expiration / floor)");

console.log("trailing volatility uses only what had settled");
const Q = 15 * 60000, T0 = Date.parse("2026-11-01T00:00:00Z");
const rets = Array.from({ length: 20 }, (_, i) => ({ close: T0 + (i + 1) * Q, ret: i < 12 ? 0.001 * (i % 2 ? 1 : -1) : 0.01 * (i % 2 ? 1 : -1) }));
const calmOpen = T0 + 12 * Q; // the window opening when the 12th return settles
ok(Math.abs(trailingVol(rets, calmOpen) - trailingVol(rets.slice(4, 12), Infinity)) < 1e-15, "the last 8 returns closed at or before the open");
ok(trailingVol(rets, calmOpen) < 0.002, "a calm stretch reads calm");
ok(trailingVol(rets, calmOpen + Q - 1) === trailingVol(rets, calmOpen), "a return still in progress is not used");
ok(trailingVol(rets, T0 + 20 * Q) > 0.009, "a wild stretch reads wild");
ok(trailingVol(rets, T0 + 7 * Q) === null, "fewer than 8 returns is no reading");
// Distinct, unevenly spaced returns, so including one window too many or
// too few changes the answer.
const sq = Array.from({ length: 20 }, (_, i) => ({ close: T0 + (i + 1) * Q, ret: (i * i) * 1e-5 }));
const sd = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
const want = sd(sq.slice(4, 12).map(x => x.ret));
ok(Math.abs(trailingVol(sq, T0 + 12 * Q) - want) < 1e-15, "the window settling exactly at the open counts; the 8 are indices 4-11");
ok(Math.abs(trailingVol(sq, T0 + 12 * Q) - sd(sq.slice(3, 11).map(x => x.ret))) > 1e-9, "and that is a different answer from one window earlier");

console.log("quantile and Welch t");
ok(quantile([5, 1, 3, 2, 4, 6], 2 / 3) === 4, "top-third cutoff by nearest rank");
ok(welchT([1, 1.1, 0.9], [0, 0.1, -0.1]) > 10, "a clear difference has a large t");
ok(welchT([1], [0, 1]) === null, "under two on a side is no t");

console.log("the verdict");
// 400 trades over 40 days of 15-minute windows; vol alternates calm/wild
// by stretch. In the "real" case wild windows lose 10c a contract and calm
// ones make 2c, in both halves.
const days = 40, perDay = 10;
const longRets = [];
for (let i = 0; i < days * 96 + 16; i++) longRets.push({ close: T0 + (i + 1) * Q, ret: (Math.floor(i / 48) % 3 === 0 ? 0.01 : 0.001) * (i % 2 ? 1 : -1) });
const mk = (effect) => {
  const out = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < perDay; k++) {
    const open = T0 + (d * 96 + 16 + k * 9) * Q, vol = trailingVol(longRets, open);
    const wild = vol > 0.005, jitter = ((d * 7 + k * 3) % 5 - 2) * 0.01;
    out.push({ t: open + 600000, open, ctrs: 40, pnl: 40 * ((wild ? effect : 0.02) + jitter) });
  }
  return out;
};
const split = T0 + 20 * 96 * Q;
const real = scoreFlag(mk(-0.10), longRets, { split });
ok(real.pass, `a real effect passes (test diff ${(real.test.diff * 100).toFixed(1)}c, t ${real.test.t?.toFixed(1)}, ${real.test.flagged} flagged)`);
const none = scoreFlag(mk(0.02), longRets, { split });
ok(!none.pass, "no effect does not pass");
const few = scoreFlag(mk(-0.10), longRets, { split, minFlagged: 10000 });
ok(!few.pass, "too few flagged trades does not pass");
const flipped = scoreFlag(mk(-0.10).map(x => x.t < split ? { ...x, pnl: -x.pnl } : x), longRets, { split });
ok(!flipped.pass, "a train half pointing the other way does not pass");
// Calm first half, wild second half: a cutoff taken over all trades would
// sit higher than the train half's own.
const drift = [];
for (let i = 0; i < days * 96 + 16; i++) drift.push({ close: T0 + (i + 1) * Q, ret: (i < 20 * 96 ? 0.001 : 0.004) * (1 + (i % 7) / 7) * (i % 2 ? 1 : -1) });
const dTrades = mk(0.02);
const dr = scoreFlag(dTrades, drift, { split });
const trainVols = dTrades.filter(x => x.t < split).map(x => trailingVol(drift, x.open)), allVols = dTrades.map(x => trailingVol(drift, x.open));
ok(quantile(trainVols, 2 / 3) !== quantile(allVols, 2 / 3), "(the two cutoffs differ on this data)");
ok(dr.cutoff === quantile(trainVols, 2 / 3), "the cutoff comes from the train half only");
const weak = scoreFlag(mk(0.019), longRets, { split });
ok(weak.test.diff > 0 && weak.test.t < 2 && weak.test.flagged >= 50 && weak.train.diff > 0 && !weak.pass, `a real but weak effect (t ${weak.test.t?.toFixed(2)}) does not pass`);

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
