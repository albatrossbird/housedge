// lib/venueFinal.js — the final-two-minutes replay, from hand-built
// archive lines.
//
// Pinned here:
//   1. The Kalshi book is replayed from its "full" line plus every "d",
//      and an edge opens at the FIRST change that makes it profitable.
//   2. A limit order arriving DELAY ms later fills against the books as
//      they stand then: before the Kalshi ask moves both legs fill, after
//      it the .us leg fills alone (legged), and once both have moved
//      neither does.
//   3. A window whose record was interrupted (a sequence gap, a socket
//      event) is not replayed, and says so.
//   4. An order that would arrive after the close counts for nothing.
//   5. A .us book older than the heartbeat is not paired.
import { newCompare, feedPmus } from "../lib/venueCompare.js";
import { newFinal, feedKalshiFinal, finalReplay, finalDelayStats, finalEpisodeStats } from "../lib/venueFinal.js";
import { pmusSlug, kalshiM15Ticker, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

const C = newCompare(), F = newFinal();
function win(startIso) {
  const start = Date.parse(startIso), close = start + WINDOW_MS;
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", close);
  feedPmus(C, { k: "mkt", t: start, m: slug, kalshi: ticker });
  return { start, close, slug, ticker };
}
const usBook = (w, x, b, a) => feedPmus(C, { k: "pb", t: x + 100, m: w.slug, x, b, a });
const kal = o => feedKalshiFinal(F, o);
const finalStart = w => {
  kal({ k: "final", t: w.close - 120000, x: w.close - 120000, m: w.ticker, close: new Date(w.close).toISOString() });
  kal({ k: "full", t: w.close - 120000, m: w.ticker, x: w.close - 120000, L: [[[0.49, 200]], [[0.51, 200]]] });
};

// Window 1: .us lifts to 60/62 at T, making YES on Kalshi at 51 + DOWN
// on .us at 40 a 9c gross edge on 50 contracts. 80ms later Kalshi's ask
// moves to 58; 300ms after T, .us falls back.
const w1 = win("2026-09-29T12:00:00Z");
const T = w1.close - 60000;
usBook(w1, w1.close - 130000, [[0.50, 100]], [[0.52, 100]]);
finalStart(w1);
usBook(w1, T, [[0.60, 50]], [[0.62, 50]]);
kal({ k: "d", t: T + 90, m: w1.ticker, sd: "a", p: 0.51, q: -200, x: T + 80 });
kal({ k: "d", t: T + 90, m: w1.ticker, sd: "a", p: 0.58, q: 200, x: T + 80 });
usBook(w1, T + 300, [[0.50, 100]], [[0.52, 100]]);
for (let i = 1; i <= 5; i++) usBook(w1, T + i * 10000, [[0.50, 100 + i]], [[0.52, 100]]);   // heartbeats

// Window 2: the same edge, but the recorder logged a sequence gap.
const w2 = win("2026-09-29T12:15:00Z");
usBook(w2, w2.close - 130000, [[0.60, 50]], [[0.62, 50]]);
finalStart(w2);
kal({ k: "gap", t: w2.close - 90000, sid: 1, expected: 5, got: 7, m: [w2.ticker] });

// Window 3: a socket event inside the final two minutes.
const w3 = win("2026-09-29T12:30:00Z");
usBook(w3, w3.close - 130000, [[0.60, 50]], [[0.62, 50]]);
finalStart(w3);
kal({ k: "conn", t: w3.close - 50000, ev: "close" });

// Window 4: direction B (NO on Kalshi at 51 + UP on .us at 40) appearing
// 30ms before the close — every order would arrive too late.
const w4 = win("2026-09-29T12:45:00Z");
usBook(w4, w4.close - 130000, [[0.50, 100]], [[0.52, 100]]);
finalStart(w4);
for (let i = 1; i <= 11; i++) usBook(w4, w4.close - 130000 + i * 10000, [[0.50, 100 + i]], [[0.52, 100]]);
usBook(w4, w4.close - 30, [[0.38, 40]], [[0.40, 40]]);

// Window 5: the last .us book is 20s older than the Kalshi record.
const w5 = win("2026-09-29T13:00:00Z");
usBook(w5, w5.close - 140000, [[0.60, 50]], [[0.62, 50]]);
finalStart(w5);
kal({ k: "d", t: w5.close - 110000, m: w5.ticker, sd: "b", p: 0.48, q: 10, x: w5.close - 110000 });

const R = finalReplay(C, F);

console.log("which windows are replayed");
ok(R.windows === 3, "three undisturbed windows replayed", JSON.stringify(R.excluded));
ok(R.excluded.disrupted === 2, "a gap and a socket event each exclude their window", JSON.stringify(R.excluded));

console.log("the edge, and what a late order finds");
const e1 = R.episodes.find(e => e.ticker === w1.ticker);
ok(e1 && e1.dir === "A" && e1.start === T, "the edge opens at the change that made it, direction A", JSON.stringify(e1));
ok(e1 && e1.size === 50 && e1.profit > 0, "sized to the thinner book", JSON.stringify(e1 && { size: e1.size, profit: e1.profit }));
ok(e1 && e1.end - e1.start === 80, "and closes 80ms later, when Kalshi's ask moves", e1 && String(e1.end - e1.start));
ok(e1?.after[50]?.both === 50 && e1.after[50].legged === 0, "+50ms: both legs fill in full", JSON.stringify(e1?.after[50]));
ok(e1?.after[100]?.both === 0 && e1.after[100].legged === 50, "+100ms: the ask has moved, .us fills alone — legged", JSON.stringify(e1?.after[100]));
ok(e1?.after[500]?.both === 0 && e1.after[500].legged === 0, "+500ms: both have moved, nothing fills", JSON.stringify(e1?.after[500]));
ok(Math.abs(e1.after[50].dollars - e1.profit) < 1e-9 && e1.after[100].dollars === 0, "dollars kept follow what filled on both legs");

console.log("too late, and too stale");
const e4 = R.episodes.find(e => e.ticker === w4.ticker);
ok(e4 && e4.dir === "B" && Object.values(e4.after).every(a => a === null), "an edge 30ms before the close: no order arrives in time", JSON.stringify(e4));
ok(!R.episodes.some(e => e.ticker === w5.ticker) && R.staleUs > 0, "a .us book 20s old is not paired", String(R.staleUs));

console.log("stats");
const D = finalDelayStats(R.episodes);
ok(D[50].known === 1 && D[50].full === 1 && D[100].legged === 1 && D[500].none === 1, "per-delay counts leave out orders that arrive after the close", JSON.stringify(D));
const S = finalEpisodeStats(R.episodes);
ok(S.n === 2 && S.under[100] >= 1, "durations in ms", JSON.stringify(S));

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
