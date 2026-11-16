// Ladder step 2's analysis (lib/ladderBook.js): gap lifetimes and the fill
// replay, on synthetic books. Recorded Kalshi data is never committed, so
// no fixture here is copied from the archive; the line SHAPES are the
// recorder's (scripts/ladder-stream.mjs), which scripts/ladder-stream.test.mjs
// drives end to end, and the book encoding is pinned by the m15-stream tests.

import { analyzeClose, summarize } from "../lib/ladderBook.js";
import { kalshiTakerFee } from "../lib/fees.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const near = (a, b, tol = 2e-3) => a != null && Math.abs(a - b) <= tol;
const fee = (p, n) => kalshiTakerFee(p, n, 1, 0.0001);
const T = Date.parse("2026-11-20T15:44:00Z"), CLOSE = "2026-11-20T15:45:00Z";

// X: the 100-199.99 bucket, which implies Y: above 99.99.
const mktX = { k: "mkt", m: "X", close: CLOSE, type: "between", floor: 100, cap: 199.99 };
const mktY = { k: "mkt", m: "Y", close: CLOSE, type: "greater", floor: 99.99 };
const fullX = (x, bid = 0.70, bs = 50) => ({ k: "full", m: "X", x, L: [[[bid, bs], [0.60, 100]], [[0.72, 50]]] });
const fullY = (x, ask = 0.60, as = 30) => ({ k: "full", m: "Y", x, L: [[[0.58, 50]], [[ask, as], [0.75, 100]]] });
const base = [mktX, mktY, fullX(T), fullY(T)];
const askGone = x => ({ k: "d", m: "Y", sd: "a", p: 0.60, q: -30, x });
const run = (lines, o = {}) => analyzeClose(lines, { fee, results: new Map([["X", "no"], ["Y", "yes"]]), ...o });

console.log("a gap opens, lasts, and closes");
{
  // X bid 0.70 over Y ask 0.60: 10c, less fees of 1.47c + 1.68c = 6.85c.
  const r = run([...base, askGone(T + 30)]);
  const e = r.episodes[0];
  ok(r.pairs === 1 && r.episodes.length === 1, "one pair, one episode");
  ok(near(e.edge0, 0.0685) && e.sizeX === 50 && e.sizeY === 30, `edge after both fees, sizes at the touch (${e.edge0?.toFixed(4)})`);
  ok(e.t0 === T && e.ms === 30 && e.cause === "quote", `it lasted 30ms and a quote closed it (${e.ms}ms, ${e.cause})`);
  ok(near(e.toClose, 60), "time to the close is recorded");
  const t = run([...base, askGone(T + 30), { k: "tr", m: "Y", x: T + 31, yp: 0.6, n: 30 }]);
  ok(t.episodes[0].cause === "trade", "a trade on either leg at that instant means someone took it");
}

console.log("what does not count");
{
  ok(run([mktX, mktY, fullX(T, 0.70, 9), fullY(T)]).episodes.length === 0, "under 10 contracts at a touch is not a qualifying gap");
  ok(run([mktX, mktY, fullX(T, 0.62), fullY(T)]).episodes.length === 0, "2c gross is eaten by the fees");
  // Y priced ABOVE X is no contradiction: Y is the wider event.
  const wrong = [mktX, mktY, { k: "full", m: "X", x: T, L: [[[0.30, 50]], [[0.32, 50]]] }, { k: "full", m: "Y", x: T, L: [[[0.70, 50]], [[0.72, 50]]] }];
  ok(run(wrong).episodes.length === 0, "the wider event priced over the narrower one is no gap");
  const grow = run([mktX, mktY, fullX(T, 0.70, 5), fullY(T), { k: "d", m: "X", sd: "b", p: 0.70, q: 20, x: T + 40 }, { k: "d", m: "X", sd: "b", p: 0.70, q: -25, x: T + 90 }]);
  ok(grow.episodes.length === 1 && grow.episodes[0].t0 === T + 40 && grow.episodes[0].ms === 50, "a gap qualifies from the instant its size is there");
}

console.log("books we cannot trust, and the close");
{
  const g = run([...base, { k: "gap", m: ["Y"], x: T + 20 }, askGone(T + 25), fullY(T + 40), askGone(T + 70)]);
  ok(g.episodes[0].cause === "unknown" && g.episodes[0].ms === 20, "a sequence gap ends the episode as unknown");
  ok(g.episodes.length === 2 && g.episodes[1].t0 === T + 40 && g.episodes[1].ms === 30, "a change to a distrusted book is ignored until its fresh snapshot");
  const c = run([...base, askGone(T + 60001)]);
  ok(c.episodes[0].cause === "close" && c.episodes[0].ms === 60000 && c.counts.afterClose === 1, "a gap open at the close ends there; later lines are ignored");
}

console.log("the fill replay");
{
  const r = run([...base, askGone(T + 30)]);
  const f = r.episodes[0].fills;
  // +0ms, 40 asked: 40 NO on X at 0.30, only 30 YES on Y at 0.60.
  ok(f["0/40"].fx === 40 && f["0/40"].fy === 30 && f["0/40"].matched === 30 && f["0/40"].excess === 10 && f["0/40"].leg === "no", "at +0ms the thinner leg caps the pair and the rest is one-legged");
  ok(near(f["0/40"].base, 30 * 0.10 - 0.588 - 0.504), `the matched part is locked in, less both fees ($${f["0/40"].base.toFixed(3)})`);
  ok(near(f["0/40"].held, 1.908 + 10 * 0.70), "held: the 10 NO contracts win because X settled No");
  ok(near(f["0/40"].unwound, 1.908 + 10 * 0.28 - 0.1412 - 10 * 0.30), `unwound: sold back at the NO bid (1 - the 0.72 ask), less a third fee ($${f["0/40"].unwound.toFixed(3)})`);
  ok(near(f["0/10"].base, 10 * 0.10 - 0.147 - 0.168) && f["0/10"].excess === 0 && f["0/10"].unwound === f["0/10"].base, "at 10 contracts both legs fill in full");
  ok(f["25/40"].fy === 30, "+25ms is still before the ask went");
  ok(f["50/40"].fy === 0 && f["50/40"].fx === 40 && f["50/40"].matched === 0, "+50ms is after: the YES leg misses and all 40 NO are one-legged");
  ok(near(f["50/40"].unwound, -0.588 + 40 * 0.28 - 0.5645 - 40 * 0.30), `and unwinding them costs the spread and two fees ($${f["50/40"].unwound.toFixed(3)})`);
  const lost = analyzeClose([...base, askGone(T + 30)], { fee, results: new Map([["X", "yes"], ["Y", "yes"]]) });
  ok(near(lost.episodes[0].fills["50/40"].held, -0.588 - 40 * 0.30), "held loses the whole stake when the one leg settles against us");
  const unk = analyzeClose([...base, askGone(T + 30)], { fee });
  ok(unk.episodes[0].fills["50/40"].held === null, "an unknown settlement is null, never zero");
}

console.log("limits and timing in the replay");
{
  // Only 20 rest at the 0.70 bid; the next bid is 0.60. A limit at the
  // price seen must not walk down to it.
  const thin = run([mktX, mktY, fullX(T, 0.70, 20), fullY(T), askGone(T + 30)]);
  ok(thin.episodes[0].fills["0/40"].fx === 20, "the NO leg stops at the price seen, not at worse bids");
  // X's ask moves 0.72 -> 0.80 at T+60. A one-legged NO fill is sold back
  // at 1 - ask: 0.28 if unwound before that, 0.20 after.
  const moved = run([...base, askGone(T + 30), { k: "d", m: "X", sd: "a", p: 0.72, q: -50, x: T + 60 }, { k: "d", m: "X", sd: "a", p: 0.80, q: 50, x: T + 60 }]);
  const f = moved.episodes[0].fills;
  ok(near(f["0/40"].unwound, 1.908 + 10 * 0.28 - 0.1412 - 10 * 0.30), "a +0ms fill is unwound at once, at the bid then");
  ok(near(f["50/40"].unwound, -0.588 + 40 * 0.20 - 0.448 - 40 * 0.30), `a +50ms fill is unwound at +100ms, at the worse bid by then ($${f["50/40"].unwound.toFixed(3)})`);
}

console.log("one order per book at a time");
{
  // Y2 is also implied by X and opens a second gap a millisecond later.
  const mktY2 = { k: "mkt", m: "Y2", close: CLOSE, type: "greater", floor: 49.99 };
  const r = run([mktX, mktY, mktY2, fullX(T), fullY(T), { k: "full", m: "Y2", x: T + 1, L: [[[0.58, 50]], [[0.60, 30]]] }]);
  const first = r.episodes.find(e => e.y === "Y"), second = r.episodes.find(e => e.y === "Y2");
  ok(first.attempted === true && second.attempted === false && r.counts.skippedBusy === 1, "a gap whose leg is already in flight is not attempted twice");
  const s = summarize(r.episodes);
  ok(s.capture["0/40"].attempts === 1, "so the same contracts are not counted twice");
}

console.log("the summary");
{
  const lines = [mktX, mktY, fullX(T), fullY(T)];
  for (let i = 0; i < 5; i++) {
    lines.push(askGone(T + 1000 * i + 10 * (i + 1)));
    lines.push({ k: "d", m: "Y", sd: "a", p: 0.60, q: 30, x: T + 1000 * (i + 1) });
  }
  const s = summarize(run(lines).episodes);
  ok(s.n === 6 && s.p50 === 40 && s.under50 === 4, `lifetimes: ${s.n} episodes, median ${s.p50}ms, ${s.under50} under 50ms`);
  ok(s.cause.quote === 5 && s.cause.close === 1, "what closed them is counted");
  ok(s.capture["0/10"].both === 6 && s.capture["250/40"].attempts === 6, "the replay is rolled up by delay and size");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
