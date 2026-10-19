// lib/m15Chase.js — ways to get more fills out of an entry rule, replayed
// on hand-built every-change windows, every price worked out by hand.
//
// Pinned here:
//   1. base: one limit at the price seen; a book that moved away is a miss.
//   2. chase +Nc: the limit N cents above, paying the WALKED price (the
//      best offer up to the limit), never above the rule's price cap.
//   3. retry: after a miss, the next qualifying moment at or after the
//      reply, until a fill or the rule's window ends; tries are counted.
//   4. A reply landing at or after the close is a miss; a window the rule
//      never fires in is null; NO buys walk the YES bids mirrored.
import { simulateChase, walkFill } from "../lib/m15Chase.js";
import { changeRows } from "../lib/m15Maker.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

const C = Date.parse("2026-10-01T12:15:00Z");
const F = (x, bids, asks) => ({ k: "F", x, L: [bids, asks] });
const D = (x, sd, p, q) => ({ k: "D", x, sd, p, q });
const win = events => ({ ticker: "KXBTC15M-W", close: C, finalT: C - 120000, events });
const market = { ticker: "KXBTC15M-W", close: C, result: "yes" };
const rule = { entry: { side: "favourite", secsMin: 15, secsMax: 45, priceMin: 0.80, priceMax: 0.97, maxSpread: 0.03 } };
const run = (events, opts = {}) => {
  const w = win(events);
  return simulateChase(w, market, changeRows(w, { maxSecs: 120 }), [["r", opts.rule || rule]], { size: 1, ...opts });
};

console.log("base, chase, retry");
{
  // 88/89 from 60s out; the size change at 40s is the first in-window row:
  // buy YES at 0.89. 50ms later the 0.89 offer is gone (ask 0.90). At 30s a
  // 0.895 offer arrives: the rule qualifies again at 0.895.
  const ev = [
    F(C - 60000, [[0.88, 10]], [[0.89, 10], [0.90, 10]]),
    D(C - 40000, "b", 0.88, 1),
    D(C - 39950, "a", 0.89, -10),
    D(C - 30000, "a", 0.895, 5),
  ];
  const r = run(ev).r;
  ok(near(r.base[100].n, 0) && r.base[100].tries === 1, "base: the 0.89 offer is gone 100ms later -> a miss", JSON.stringify(r.base));
  ok(r["chase+1c"][100].n === 1 && near(r["chase+1c"][100].cost, 0.90), "chase +1c: limit 0.90, fills at 0.90", JSON.stringify(r["chase+1c"]));
  ok(r["chase+2c"][100].n === 1 && near(r["chase+2c"][100].cost, 0.90), "chase +2c: limit 0.91 but pays the 0.90 on offer, not the limit", JSON.stringify(r["chase+2c"]));
  ok(r.retry[100].n === 1 && r.retry[100].tries === 2 && near(r.retry[100].cost, 0.895), "retry: misses at 0.89, the rule fires again at 30s and fills at 0.895", JSON.stringify(r.retry));
  ok(r["retry+1c"][100].n === 1 && r["retry+1c"][100].tries === 1 && near(r["retry+1c"][100].cost, 0.90), "retry +1c: the first try already fills", JSON.stringify(r["retry+1c"]));
  ok(r.base[100].pq === undefined && near(r.retry[100].pq, 0.895 * 0.105), "the fee factor is q x p(1-p) of what was paid (a miss carries none)", JSON.stringify(r.retry[100]));
  ok(r.base[250].n === 0 && r.retry[250].n === 1, "the same at 250ms");
}

console.log("the price cap, the close, NO, nothing decided");
{
  // Decided at 0.97, the cap. The offer moves to 0.975: +1c may not chase
  // past the rule's 0.97.
  const capped = run([F(C - 60000, [[0.95, 10]], [[0.97, 10], [0.975, 10]]), D(C - 40000, "b", 0.95, 1), D(C - 39950, "a", 0.97, -10)]).r;
  ok(capped.base[100].n === 0 && capped["chase+2c"][100].n === 0, "a 0.97 decision is not chased to 0.975", JSON.stringify(capped));
  // A decision 16s out with a 250ms reply is still inside; one 15.1s out
  // whose retry would only find rows after the window -> retry gives up.
  const late = run([F(C - 60000, [[0.88, 10]], [[0.89, 10], [0.92, 10]]), D(C - 15100, "b", 0.88, 1), D(C - 15050, "a", 0.89, -10)]).r;
  ok(late.retry[100].n === 0 && late.retry[100].tries === 1, "no qualifying moment after the miss -> retry stops at one try", JSON.stringify(late.retry));
  const closing = run([F(C - 60000, [[0.88, 10]], [[0.89, 10]]), D(C - 15000, "b", 0.88, 1)], { rule: { entry: { ...rule.entry, secsMin: 0 } }, delays: [250] }).r;
  ok(closing.base[250].n === 1, "15s out + 250ms is still before the close");
  const atClose = run([F(C - 60000, [[0.88, 10]], [[0.89, 10]]), D(C - 100, "b", 0.88, 1)], { rule: { entry: { ...rule.entry, secsMin: 0 } }, delays: [250] }).r;
  ok(atClose.base[250].n === 0 && atClose.base[250].tries === 1, "a reply landing after the close is a miss", JSON.stringify(atClose.base));
  // NO favourite: 10/12 book, NO costs 1 - 0.10 = 0.90; the 0.10 bid
  // empties, the next bid 0.09 sells NO at 0.91.
  const no = run([F(C - 60000, [[0.10, 5], [0.09, 5]], [[0.12, 10]]), D(C - 40000, "a", 0.12, 1), D(C - 39950, "b", 0.10, -5)]).r;
  ok(no.base[100].n === 0 && no["chase+1c"][100].n === 1 && near(no["chase+1c"][100].cost, 0.91) && no["chase+1c"][100].side === "no", "NO walks the YES bids mirrored: 0.09 bid = NO at 0.91", JSON.stringify(no["chase+1c"]));
  const never = run([F(C - 60000, [[0.40, 10]], [[0.42, 10]]), D(C - 40000, "b", 0.40, 1)]).r;
  ok(never.base[100] === null && never.retry[100] === null, "a window the rule never fires in is null, not a miss");
}

console.log("walking the book");
{
  const snap = { bids: [[0.50, 3]], asks: [[0.90, 1], [0.905, 2], [0.91, 5]] };
  const f = walkFill(snap, "yes", 0.905, 10);
  ok(f.n === 3 && near(f.cost, 0.90 + 2 * 0.905), "takes every level up to the limit and no further", JSON.stringify(f));
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
