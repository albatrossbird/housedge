// lib/venueStream.js — the venue comparison read hour by hour, each window
// reduced and let go, must give exactly what reading the whole day at once
// gives. Built archive lines, several hours of windows, fed both ways.
//
// Pinned here:
//   1. Every count, episode and the lead/lag row match the batch path.
//   2. Windows are let go: after the read nothing is held but what has
//      not closed.
//   3. A line for an already-reduced window is left out, and counted as
//      late only if it is stamped before that window's close + 2s.
//   4. kalshiM15Close() inverts kalshiM15Ticker(), DST included.
import { newCompare, feedKalshi, feedPmus, summarize } from "../lib/venueCompare.js";
import { newFinal, feedKalshiFinal, finalReplay } from "../lib/venueFinal.js";
import { newCompareRun, feedRunPmus, feedRunKalshi, settleRun, finishRun, SETTLE_MS } from "../lib/venueStream.js";
import { pmusSlug, kalshiM15Ticker, kalshiM15Close, WINDOW_MS } from "../lib/pmus15.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// A seeded generator, so a failure reproduces.
let seed = 20261026;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const r2 = x => Math.round(x * 100) / 100;
const clamp = x => Math.min(0.97, Math.max(0.03, x));

// Lines on the box's clock (t), each tagged with the archive it lives in.
const lines = [];
const P = (o) => lines.push({ arc: "p", o });
const K = (o) => lines.push({ arc: "k", o });

const T0 = Date.parse("2026-10-20T10:00:00Z");
const WINDOWS = 18;   // 4.5 hours
for (let i = 0; i < WINDOWS; i++) {
  const start = T0 + i * WINDOW_MS, close = start + WINDOW_MS;
  const slug = pmusSlug("btc", start), ticker = kalshiM15Ticker("btc", close);
  const noUs = i === 4, noKalshi = i === 9;
  if (!noUs) P({ k: "mkt", t: start - 60000, m: slug, kalshi: noKalshi ? undefined : ticker });
  let mid = 0.3 + 0.4 * rnd();
  // Kalshi 1-second books from a minute before the open to just past the close.
  for (let x = start - 60000; x <= close + 3000; x += 1000) {
    mid = clamp(mid + (rnd() - 0.5) * 0.02);
    const b = r2(mid - 0.01), a = r2(mid + 0.01);
    const L = [[[b, 100], [r2(b - 0.01), 300], [r2(b - 0.02), 500]], [[a, 100], [r2(a + 0.01), 300], [r2(a + 0.02), 500]]];
    if (!noKalshi) K({ k: "b", t: x + 20, x, m: ticker, b, a, L });
    // .us: a few books a second, its mid wandering a few cents off Kalshi's.
    for (let j = 0; j < 3 && !noUs; j++) {
      const ux = x + j * 330, um = clamp(mid + (rnd() - 0.5) * 0.09);
      P({ k: "pb", t: ux + 5, x: ux, m: slug, b: [[r2(um - 0.01), 40 + Math.floor(rnd() * 200)], [r2(um - 0.03), 400]], a: [[r2(um + 0.01), 40 + Math.floor(rnd() * 200)], [r2(um + 0.03), 400]] });
    }
  }
  if (noKalshi) continue;
  // The final two minutes: a full book, then changes every ~150ms.
  const f0 = close - 120000;
  K({ k: "final", t: f0, x: f0, m: ticker, close: new Date(close).toISOString() });
  const fb = r2(mid - 0.01), fa = r2(mid + 0.01);
  K({ k: "full", t: f0 + 1, x: f0, m: ticker, L: [[[fb, 200], [r2(fb - 0.01), 400]], [[fa, 200], [r2(fa + 0.01), 400]]] });
  const book = { b: new Map([[fb, 200], [r2(fb - 0.01), 400]]), a: new Map([[fa, 200], [r2(fa + 0.01), 400]]) };
  for (let x = f0 + 150; x < close + 2000; x += 100 + Math.floor(rnd() * 100)) {
    const sd = rnd() < 0.5 ? "b" : "a", side = book[sd];
    const p = r2(sd === "b" ? mid - 0.01 - 0.01 * Math.floor(rnd() * 3) : mid + 0.01 + 0.01 * Math.floor(rnd() * 3));
    const have = side.get(p) || 0, q = rnd() < 0.5 && have > 0 ? -have : 50 + Math.floor(rnd() * 150);
    side.set(p, have + q);
    K({ k: "d", t: x + 15, x, m: ticker, sd, p, q });
    mid = clamp(mid + (rnd() - 0.5) * 0.004);
  }
  // Interruptions: a socket event in one window, a sequence gap in another.
  if (i === 6) K({ k: "conn", t: close - 30000, ev: "close" });
  if (i === 11) K({ k: "gap", t: close - 45000, sid: 1, expected: 3, got: 5, m: [ticker] });
}
lines.sort((x, y) => x.o.t - y.o.t);

// Batch: everything at once, the .us archive first, as the script used to.
const C = newCompare(), F = newFinal();
for (const { arc, o } of lines) if (arc === "p") feedPmus(C, o);
for (const { arc, o } of lines) if (arc === "k") { feedKalshi(C, o); feedKalshiFinal(F, o); }
const S0 = summarize(C), R0 = finalReplay(C, F);

// Stream: hour by hour, .us then Kalshi within each hour, as the script does.
const run = newCompareRun();
const hourOf = t => Math.floor(t / 3600000) * 3600000;
let peakWindows = 0;
for (const h of [...new Set(lines.map(l => hourOf(l.o.t)))].sort((a, b) => a - b)) {
  for (const { arc, o } of lines) if (arc === "p" && hourOf(o.t) === h) feedRunPmus(run, o);
  for (const { arc, o } of lines) if (arc === "k" && hourOf(o.t) === h) feedRunKalshi(run, o);
  peakWindows = Math.max(peakWindows, run.C.kalshi.size + run.C.pmus.size);
  settleRun(run, h + 3600000);
}
const heldBeforeFinish = run.C.kalshi.size + run.F.win.size + run.C.pmus.size;
const { S, R } = finishRun(run);

const epKey = e => `${e.ticker}|${e.dir}|${e.start}`;
const norm = X => ({ ...X, episodes: [...X.episodes].sort((a, b) => epKey(a).localeCompare(epKey(b))) });

console.log("venue comparison, streamed against batch:");
ok(S0.windows > 10 && S0.episodes.length > 0, `the fixture exercises the summary (${S0.windows} windows, ${S0.episodes.length} episodes)`);
ok(R0.windows > 5 && R0.episodes.length > 0, `the fixture exercises the replay (${R0.windows} windows, ${R0.episodes.length} edges)`);
ok(R0.excluded.disrupted === 2 && R0.excluded.noUs === 1, "and its exclusions", JSON.stringify(R0.excluded));
ok(JSON.stringify(norm(S)) === JSON.stringify(norm(S0)), "summary identical: counts, every episode with its delays, lead/lag");
ok(JSON.stringify(norm(R)) === JSON.stringify(norm(R0)), "final-two-minutes replay identical");
ok(run.late === 0, "nothing late in an on-time archive", String(run.late));

console.log("\nwindows are let go:");
ok(peakWindows <= 16, `never more than about an hour of windows held (peak ${peakWindows} Kalshi + .us books, of ${2 * WINDOWS})`);
ok(heldBeforeFinish <= 12, `before the final settle only the last hour's windows remain (${heldBeforeFinish})`);
ok(run.C.kalshi.size === 0 && run.F.win.size === 0 && run.C.pmus.size === 0, "after the read, nothing");

console.log("\nlate lines:");
{
  const r = newCompareRun();
  const close = T0 + WINDOW_MS, slug = pmusSlug("btc", T0), ticker = kalshiM15Ticker("btc", close);
  feedRunPmus(r, { k: "mkt", t: T0 - 1000, m: slug, kalshi: ticker });
  feedRunPmus(r, { k: "pb", t: close - 5000, x: close - 5000, m: slug, b: [[0.5, 10]], a: [[0.52, 10]] });
  feedRunKalshi(r, { k: "b", t: close - 5000, x: close - 5000, m: ticker, b: 0.5, a: 0.52, L: [[[0.5, 10]], [[0.52, 10]]] });
  settleRun(r, close + SETTLE_MS - 1);
  ok(r.C.kalshi.size === 1, "a window is held until SETTLE_MS past its close");
  settleRun(r, close + SETTLE_MS + 1);
  ok(r.C.kalshi.size === 0 && r.C.pmus.size === 0 && r.S.windows === 1, "and reduced and let go after it");
  feedRunKalshi(r, { k: "b", t: close + SETTLE_MS + 5, x: close + 5000, m: ticker, b: 0.5, a: 0.52, L: [[], []] });
  feedRunPmus(r, { k: "pb", t: close + SETTLE_MS + 5, x: close + 4000, m: slug, b: [], a: [] });
  ok(r.late === 0 && r.C.kalshi.size === 0 && r.C.pmus.size === 0, "a line stamped past close + 2s is dropped quietly (nothing reads it)");
  feedRunKalshi(r, { k: "b", t: close + SETTLE_MS + 6, x: close - 1000, m: ticker, b: 0.5, a: 0.52, L: [[], []] });
  feedRunPmus(r, { k: "pb", t: close + SETTLE_MS + 6, x: close - 900, m: slug, b: [], a: [] });
  ok(r.late === 2 && r.C.kalshi.size === 0 && r.C.pmus.size === 0, "one stamped before it is dropped and counted late", String(r.late));
}

console.log("\nKalshi 15-minute ticker -> close:");
for (const iso of ["2026-09-28T21:45:00Z", "2026-12-15T00:00:00Z", "2026-03-08T07:00:00Z", "2026-11-01T04:45:00Z", "2026-11-01T07:00:00Z"]) {
  const t = Date.parse(iso);
  ok(kalshiM15Close(kalshiM15Ticker("btc", t)) === t, `${iso} round-trips (${kalshiM15Ticker("btc", t)})`);
}
{
  // 01:15 ET on the day the clocks go back happens twice; the later is returned.
  const second = Date.parse("2026-11-01T06:15:00Z");
  ok(kalshiM15Close(kalshiM15Ticker("btc", second)) === second, "the hour the clocks go back reads as the later one");
}
ok(kalshiM15Close("KXBTC15M-26SEP281745-45") === Date.parse("2026-09-28T21:45:00Z"), "KXBTC15M-26SEP281745-45 closes 21:45 UTC");
ok(kalshiM15Close("KXNOPE15M-26SEP281745-45") === null && kalshiM15Close("junk") === null, "an unknown series or shape is null");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
