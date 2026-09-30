// lib/venueCompare.js — Kalshi KXBTC15M against Polymarket US's 15-minute
// BTC market, reduced from hand-built archive lines.
//
// Pinned here:
//   1. Fees are each venue's own: Kalshi rounds the ORDER up to the cent,
//      .us rounds half-even; a gap smaller than both is not an edge.
//   2. The walk takes the size that makes the most money, not the most
//      contracts, and never more than the thinner book holds.
//   3. A sample pairs a FRESH Kalshi book with the .us book current at
//      that instant; a .us book older than the heartbeat is not paired,
//      and nothing after the window's close counts.
//   4. Consecutive profitable samples are ONE episode, and its dollars
//      are its best moment, not a sum of samples.
//   5. The mirror check and the lead/lag both point the right way on a
//      book known to follow Kalshi by one sample.
import { newCompare, feedKalshi, feedPmus, summarize, episodeStats, bestFill, pmusTakerFee } from "../lib/venueCompare.js";
import { pmusSlug, kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

console.log("fees");
ok(pmusTakerFee(0.5, 100) === 1.74, ".us at 50c on 100: 0.0695 x 25 = 1.7375 -> 1.74", pmusTakerFee(0.5, 100));
ok(pmusTakerFee(0.5, 0) === 0 && pmusTakerFee(1, 10) === 0, "no fee on nothing, or at a certain price");

console.log("the walk");
{
  // YES on Kalshi at 40c (100 deep) + DOWN on .us at 50c (50 deep): 10c gross.
  const f = bestFill([[0.40, 100]], [[0.50, 50]]);
  // Kalshi 50 x 0.07 x 0.24 = 0.84; .us 50 x 0.0695 x 0.25 = 0.86875 -> 0.87.
  ok(f.size === 50 && near(f.profit, 50 * 0.10 - 0.84 - 0.87, 1e-6), "stops at the thinner book, fees as each venue rounds them", JSON.stringify(f));
  ok(near(f.gross, 0.10), "gross edge at the touch");
  const none = bestFill([[0.50, 100]], [[0.51, 100]]);
  ok(none.profit < 0, "a book 1c apart the wrong way is a loss, not an edge");
  const thin = bestFill([[0.50, 100]], [[0.48, 100]]);
  ok(thin.profit < 0, "a 2c gross cross does not pay ~3.5c of fees", JSON.stringify(thin));
  // A deep second level that is too expensive must not be taken.
  const two = bestFill([[0.40, 10], [0.60, 1000]], [[0.50, 1000]]);
  ok(two.size === 10, "takes the size that makes the most money, not the most contracts", JSON.stringify(two));
}

console.log("end to end");
{
  const start = Date.parse("2026-09-29T12:00:00Z");
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
  const C = newCompare();
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  feedPmus(C, { k: "conn", t: start, ev: "open" });
  // A random walk for Kalshi's mid; .us quotes Kalshi's PREVIOUS mid (it
  // follows by one sample). A 1c spread on both.
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let mid = 0.5; const mids = [];
  for (let i = 0; i < 300; i++) { mid = Math.min(0.8, Math.max(0.2, mid + (rnd() < 0.5 ? -0.01 : 0.01))); mids.push(Math.round(mid * 1000) / 1000); }
  const book = m => ({ b: Math.round((m - 0.005) * 1000) / 1000, a: Math.round((m + 0.005) * 1000) / 1000 });
  for (let i = 0; i < 300; i++) {
    const t = start + 1000 + i * 1000;
    const k = book(mids[i]);
    feedKalshi(C, { k: "b", t, m: ticker, b: k.b, a: k.a, L: [[[k.b, 500]], [[k.a, 500]]] });
    let p = book(mids[Math.max(0, i - 1)]);
    // Samples 100-102: .us's Up bid jumps 8c above Kalshi's ask.
    if (i >= 100 && i <= 102) p = { b: Math.round((k.a + 0.08) * 1000) / 1000, a: Math.round((k.a + 0.09) * 1000) / 1000 };
    feedPmus(C, { k: "pb", t: t - 200, m: slug, b: [[p.b, 200]], a: [[p.a, 200]] });
  }
  // A Kalshi book after the close, and one whose .us book is stale.
  feedKalshi(C, { k: "b", t: start + WINDOW_MS + 5000, m: ticker, b: 0.5, a: 0.51, L: [[[0.5, 1]], [[0.51, 1]]] });
  // Other series are ignored.
  feedKalshi(C, { k: "b", t: start + 5000, m: "KXETH15M-X", b: 0.1, a: 0.9, L: [[], []] });

  const S = summarize(C);
  ok(S.windows === 1, "one window on both venues");
  ok(S.samples === 300, "every in-window Kalshi book paired; none after the close", `samples=${S.samples}`);
  ok(S.agree.twoSided === S.samples && S.agree.within1c > 0.9 * S.samples, "touches agree", JSON.stringify(S.agree));
  ok(S.agree.decisive > 50 && S.agree.decisiveWithin1c > 0.9 * S.agree.decisive && S.agree.mirrorWithin1c < 0.2 * S.agree.decisive, "away from 50c, Up=YES agrees and the mirror does not", JSON.stringify(S.agree));
  const E = episodeStats(S.episodes);
  const a = S.episodes.filter(e => e.dir === "A");
  ok(a.length === 1 && a[0].samples === 3, "three consecutive profitable samples are ONE episode", JSON.stringify(S.episodes.map(e => [e.dir, e.samples])));
  ok(a.length === 1 && near(E.dollars, a[0].bestProfit + S.episodes.filter(e => e.dir !== "A").reduce((s, e) => s + e.bestProfit, 0)), "episode dollars are best moments, not sums");
  ok(a.length === 1 && a[0].bestSize === 200, "sized to the thinner book (200 on .us)");
  const peak = Object.entries(S.leadLag).filter(([, c]) => c != null).sort((x, y) => y[1] - x[1])[0];
  ok(peak && peak[0] === "1", "a .us book one sample behind reads as .us following Kalshi (+1)", JSON.stringify(S.leadLag));
  ok(S.byBucket[">10m"].samples + S.byBucket["5-10m"].samples + S.byBucket["2-5m"].samples + S.byBucket["1-2m"].samples + S.byBucket["<1m"].samples === S.samples, "every sample lands in one time-to-close bucket");
}

console.log("a stale .us book is not paired");
{
  const start = Date.parse("2026-09-29T13:00:00Z");
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
  const C = newCompare();
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  feedPmus(C, { k: "pb", t: start + 1000, m: slug, b: [[0.49, 10]], a: [[0.5, 10]] });
  feedKalshi(C, { k: "b", t: start + 2000, m: ticker, b: 0.49, a: 0.5, L: [[[0.49, 10]], [[0.5, 10]]] });
  feedKalshi(C, { k: "b", t: start + 30000, m: ticker, b: 0.49, a: 0.5, L: [[[0.49, 10]], [[0.5, 10]]] });
  const S = summarize(C);
  ok(S.samples === 1, "a .us book 29s old is not treated as current", `samples=${S.samples}`);
}

console.log("a one-sided book near the close is still sampled");
{
  const start = Date.parse("2026-09-29T15:00:00Z");
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
  const C = newCompare();
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  // 30s before the close, Kalshi has decided: YES bid at 0.97, nothing
  // offered. .us still offers Up at 0.90. Direction B (UP on .us + NO on
  // Kalshi at 1 - 0.97 = 0.03) costs 0.93 before fees.
  const t = start + WINDOW_MS - 30000;
  feedPmus(C, { k: "pb", t: t - 500, x: t - 500, m: slug, b: [[0.89, 500]], a: [[0.90, 500]] });
  feedKalshi(C, { k: "b", t, x: t, m: ticker, b: 0.97, a: null, L: [[[0.97, 500]], []] });
  const S = summarize(C);
  ok(S.samples === 1 && S.agree.twoSided === 0 && S.oneSided["<1m"] === 1, "sampled, counted as one-sided, kept out of the agreement stats", JSON.stringify({ n: S.samples, a: S.agree, o: S.oneSided }));
  ok(S.byDir.B.positive === 1 && S.byBucket["<1m"].positive === 1, "and the direction whose legs exist is still priced", JSON.stringify(S.byDir));
  ok(S.byDir.A.positive === 0, "the direction with a missing leg is not", JSON.stringify(S.byDir));
}
{
  const start = Date.parse("2026-09-29T16:00:00Z");
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
  const C = newCompare();
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  const t = start + WINDOW_MS - 20000;
  feedPmus(C, { k: "pb", t: t - 60000, x: t - 60000, m: slug, b: [[0.5, 5]], a: [[0.51, 5]] });   // a minute old
  feedKalshi(C, { k: "b", t, x: t, m: ticker, b: 0.5, a: 0.51, L: [[[0.5, 5]], [[0.51, 5]]] });
  const S = summarize(C);
  ok(S.samples === 0 && S.skipped["<1m"].noPmus === 1, "a Kalshi book with no CURRENT .us book is counted as skipped, by time to close", JSON.stringify(S.skipped));
}

console.log("exchange clocks: a recorder minutes behind still pairs the right moments");
{
  const start = Date.parse("2026-09-29T14:00:00Z");
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", start + WINDOW_MS);
  const C = newCompare();
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  // Both venues at 40/41 until +60s, then both at 70/71. The .us recorder
  // is live; the Kalshi one received everything 300s late.
  for (let i = 0; i < 120; i++) {
    const x = start + 1000 + i * 1000, hi = i >= 60;
    const b = hi ? 0.70 : 0.40, a = hi ? 0.71 : 0.41;
    feedPmus(C, { k: "pb", t: x + 100, x, m: slug, b: [[b, 100]], a: [[a, 100]] });
    feedKalshi(C, { k: "b", t: x + 300000, x, m: ticker, b, a, L: [[[b, 100]], [[a, 100]]] });
  }
  const S = summarize(C);
  ok(S.samples === 120 && S.agree.exact === 120, "every sample pairs the same instant on both venues", JSON.stringify(S.agree));
  ok(S.episodes.length === 0, "and a stale Kalshi book is not read as an edge", JSON.stringify(S.episodes.map(e => [e.dir, e.bestTouchEdge])));
  ok(Math.round(C.kalshiLagMs[0] / 1000) === 300, "the lag is reported", C.kalshiLagMs[0]);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
