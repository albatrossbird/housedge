// The resting-quote replay (lib/mmReplay.js), worked by hand.

import { replay, tickerHash, poolRateFor } from "../lib/mmReplay.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const MIN = 60000;
// A book of 0.40 / 0.44 from minute 0, sizes 200 a side.
const base = { quotes: [[0, 0.40, 0.44]], from: 0, to: 10 * MIN, sizeYes: 200, sizeNo: 200 };
const T = (min, price, count, taker) => ({ t: min * MIN + 1000, price, count, taker });

console.log("fills");
{
  const at = [T(2, 0.40, 50, "no")];
  const f = replay({ ...base, trades: at, mode: "front" }), b = replay({ ...base, trades: at, mode: "back" });
  ok(f.fills === 1 && f.yes === 50 && near(f.pnl, 0), "front: a seller printing AT our bid fills us, and marked at that bid it is worth what was paid");
  ok(b.fills === 0 && b.yes === 0, "back: a print at our price does not fill us");
  const thru = [T(2, 0.38, 500, "no")];
  for (const mode of ["front", "back"]) {
    const r = replay({ ...base, trades: thru, mode });
    ok(r.yes === 200 && near(r.pnl, 0), `${mode}: a print THROUGH our bid fills us at our price, capped at the size posted`);
  }
  const buy = replay({ ...base, trades: [T(2, 0.45, 30, "yes")], mode: "back" });
  ok(buy.no === 30 && near(buy.pnl, -30 * 0.56 + 30 * (1 - 0.44)), "a buyer printing through our ask fills the NO side at one minus the ask");
  ok(replay({ ...base, trades: [T(2, 0.43, 30, "yes")], mode: "front" }).fills === 0, "a buyer under our ask does not");
  ok(replay({ ...base, trades: [{ t: -5000, price: 0.30, count: 99, taker: "no" }, { t: 10 * MIN + 1, price: 0.30, count: 99, taker: "no" }], mode: "front" }).fills === 0, "trades outside the window are ignored");
}

console.log("the book moving against us");
{
  // Filled 200 at 0.40 in minute 2; the book is 0.30 / 0.34 from minute 3.
  const r = replay({ ...base, quotes: [[0, 0.40, 0.44], [3 * MIN, 0.30, 0.34]], trades: [T(2, 0.35, 200, "no")], mode: "back" });
  ok(near(r.pnl, -200 * 0.40 + 200 * 0.30), `inventory is sold at the last bid, not the mid (${r.pnl.toFixed(2)})`);
  ok(near(r.vsMid[0].sum / r.vsMid[0].q, 0.02) && near(r.vsMid[1].sum / r.vsMid[1].q, 0.32 - 0.40), "the diagnosis: +2c against the mid at the fill, -8c a minute later");
  ok(near(r.maxCost, 80), "the most money tied up is reported");
  const s = replay({ ...base, trades: [T(2, 0.35, 200, "no")], mode: "back", settle: 0 });
  ok(near(s.pnl, -80), "a settled market marks inventory at settlement: YES bought at 40c that settles no loses it all");
  ok(near(replay({ ...base, trades: [T(2, 0.35, 200, "no")], mode: "back", settle: 1 }).pnl, 120), "and one that settles yes pays $1");
}

console.log("the position cap");
{
  // Minute 2: filled 200 YES. Minute 3: another seller comes through; the YES
  // side is full and posts nothing. Minute 4: a buyer through the ask sells
  // our position back out.
  const tr = [T(2, 0.35, 200, "no"), T(3, 0.35, 200, "no"), T(4, 0.50, 200, "yes")];
  const r = replay({ ...base, trades: tr, mode: "back" });
  ok(r.fills === 2 && r.yes === 200 && r.no === 200, "a full side posts nothing until the other side trades it down");
  ok(near(r.pnl, -200 * 0.40 - 200 * 0.56 + 200), `bought at 40c and sold at 44c: the pair is worth $1 (${r.pnl.toFixed(2)})`);
  // After the round trip both sides post in full again.
  const again = replay({ ...base, trades: [...tr, T(5, 0.35, 500, "no")], mode: "back" });
  ok(again.yes === 400 && again.no === 200, "and then both sides post in full again");
  // Short 200 (NO held): the YES side still posts only its own size.
  const short = replay({ ...base, trades: [T(2, 0.50, 200, "yes"), T(3, 0.30, 900, "no")], mode: "back" });
  ok(short.no === 200 && short.yes === 200, "a short position does not let the other side post more than its size");
}

console.log("the reward");
{
  const poolRate = () => 0.01;   // $14.40 a day
  const r = replay({ ...base, trades: [], shareYes: 0.5, shareNo: 0.25, poolRate });
  ok(near(r.reward, 10 * 0.01 * (0.5 + 0.25) / 2), `both sides posted: pool x the average of the two shares (${r.reward.toFixed(4)} over 10 minutes)`);
  // Filled to the cap in minute 0: from minute 1 the YES side posts nothing.
  const full = replay({ ...base, trades: [T(0, 0.35, 200, "no")], shareYes: 0.5, shareNo: 0.25, poolRate, mode: "back" });
  ok(near(full.reward, 0.01 * (0.75 / 2) + 9 * 0.01 * (0.25 / 2)), "a side that is full earns nothing while it is not posted");
  const half = replay({ ...base, trades: [T(0, 0.35, 100, "no")], shareYes: 0.5, shareNo: 0.25, poolRate, mode: "back" });
  ok(near(half.reward, 0.01 * 0.375 + 9 * 0.01 * (0.5 * 0.5 + 0.25) / 2), "a side posted at half size earns half its share");
  ok(replay({ ...base, quotes: [[0, null, 0.44]], trades: [], shareYes: 0.5, shareNo: 0.25, poolRate }).reward === 0, "a one-sided market earns nothing for a quote that only joins");
  ok(replay({ ...base, quotes: [[5 * MIN, 0.40, 0.44]], trades: [], shareYes: 1, shareNo: 1, poolRate }).quoted === 5, "minutes before the first candle are not quoted");
  const rate = poolRateFor([{ start_date: "2026-11-01T00:00:00Z", end_date: "2026-11-02T00:00:00Z", period_reward: 144000 }, { start_date: "2026-11-01T12:00:00Z", end_date: "2026-11-03T12:00:00Z", period_reward: 288000 }]);
  ok(near(rate(Date.parse("2026-11-01T06:00:00Z")), 0.01) && near(rate(Date.parse("2026-11-01T18:00:00Z")), 0.02) && rate(Date.parse("2026-11-04T00:00:00Z")) === 0, "overlapping programs add; outside them the pool is nothing");
}

console.log("supplying an empty side");
{
  // No YES bid, ask 0.03: the supply quote bids 0.02; a join quote posts nothing there.
  const q = { ...base, quotes: [[0, null, 0.03]], trades: [T(1, 0.01, 1000, "no")], sizeYes: 1000, sizeNo: 200, mode: "back" };
  ok(replay(q).fills === 0, "a join quote has no bid on an empty side");
  const s = replay({ ...q, supplyEmpty: true });
  ok(s.yes === 1000 && near(s.pnl, -1000 * 0.02), `a supply quote rests a tick inside the ask and, hit, holds the long shot (${s.pnl.toFixed(2)} marked at no bid)`);
  // A 98c market with no ask: the supply quote's NO bid is 1c.
  const hi = replay({ ...base, quotes: [[0, 0.98, null]], trades: [T(1, 1.0, 1000, "yes")], sizeYes: 200, sizeNo: 1000, supplyEmpty: true, mode: "back" });
  ok(hi.no === 1000 && near(hi.pnl, -1000 * 0.01), "and on a 98c market it is the NO side at 1c");
}

console.log("fees, weeks, the draw");
{
  const r = replay({ ...base, trades: [T(2, 0.35, 200, "no")], mode: "back", fee: (p, q) => 0.0175 * q * p * (1 - p) });
  ok(near(r.fees, 0.0175 * 200 * 0.24) && near(r.pnl, -r.fees), "a maker fee is charged on each fill");
  const w = replay({ ...base, quotes: [[0, 0.40, 0.44], [6 * MIN, 0.30, 0.34]], trades: [T(2, 0.35, 200, "no")], mode: "back", boundary: 5 * MIN, shareYes: 1, shareNo: 1, poolRate: () => 0.01 });
  ok(near(w.week[0].pnl, 0) && near(w.week[1].pnl, -20) && near(w.week[0].pnl + w.week[1].pnl, w.pnl), "P&L splits at the boundary, the first part marked at the book then");
  ok(near(w.week[0].reward + w.week[1].reward, w.reward) && w.week[0].quoted === 5 && w.week[1].quoted === 5, "reward and quoted minutes split the same way");
  ok(tickerHash("KXRT-HUN-70") === tickerHash("KXRT-HUN-70") && tickerHash("KXRT-HUN-70") !== tickerHash("KXRT-HUN-72"), "the draw is a fixed function of the ticker");
  let threw = false; try { replay({ ...base, trades: [], mode: "middle" }); } catch { threw = true; }
  ok(threw, "an unknown fill mode is refused");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
