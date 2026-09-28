// lib/streamReport.js — the reductions behind scripts/m15-stream-report.mjs.
import { newReport, feedLine, touchAt, comparePoller, closeCalibration, summary } from "../lib/streamReport.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const T0 = Date.parse("2026-09-28T10:00:00Z");
const close = T0 + 15 * 60000;

const R = newReport();
feedLine(R, { k: "mkt", t: T0, m: "KXBTC15M-A", close: new Date(close).toISOString(), strike: 80000 });
for (let s = 0; s < 900; s += 1) {
  // YES bid drifts up: 0.40 -> ~0.85 over the window
  const b = Math.round((0.40 + s * 0.0005) * 100) / 100;
  feedLine(R, { k: "b", t: T0 + s * 1000, m: "KXBTC15M-A", b, a: Math.round((b + 0.01) * 100) / 100 });
}
feedLine(R, { k: "d", t: close - 5000, m: "KXBTC15M-A" });
feedLine(R, { k: "tr", t: close - 4000, m: "KXBTC15M-A", n: 25 });
feedLine(R, { k: "i5", t: T0, id: "BRTI" }); feedLine(R, { k: "i5", t: T0 + 200, id: "BRTI" }); feedLine(R, { k: "i5", t: T0 + 5200, id: "BRTI" });
feedLine(R, { k: "conn", t: T0, ev: "open" }); feedLine(R, { k: "gap", t: T0, sid: 1 });

console.log("the book at a moment");
ok(touchAt(R, "KXBTC15M-A", T0 + 10500)?.b === 0.41, "latest snapshot at or before the time");
ok(touchAt(R, "KXBTC15M-A", T0 - 1) === null, "nothing before the first snapshot");
ok(touchAt(R, "KXBTC15M-A", close + 60000) === null, "a snapshot older than 15s does not describe the book");
ok(touchAt(R, "NOPE", T0) === null, "unknown ticker");

console.log("\nthe poller against the stream");
{
  const P = comparePoller(R, [
    { ticker: "KXBTC15M-A", observed_at: new Date(T0 + 100000).toISOString(), yes_bid: 0.30, yes_ask: 0.31, book_bid: 0.45, book_ask: 0.46 },
    { ticker: "KXBTC15M-A", observed_at: new Date(T0 + 200000).toISOString(), yes_bid: 0.50, yes_ask: 0.51, book_bid: 0.51, book_ask: 0.52 },
    { ticker: "KXBTC15M-A", observed_at: new Date(T0 - 5000).toISOString(), yes_bid: 0.4, yes_ask: 0.41, book_bid: null, book_ask: null },
  ]);
  ok(P.compared === 2, "rows without a stream book are not compared");
  ok(P.list.exact === 1 && P.list.n === 2, "the stale cached price is caught");
  ok(P.book.exact === 1 && P.book.within1c === 2, "a book a tick away counts within 1c, not exact");
}

console.log("\nthe close");
{
  const C = closeCalibration(R, [{ ticker: "KXBTC15M-A", close_time: new Date(close).toISOString(), result: "yes" },
                                 { ticker: "KXBTC15M-A", close_time: new Date(close).toISOString(), result: "" }]);
  ok(C.windows === 1, "an unsettled window is skipped");
  ok(C.table[60][8].n === 1 && C.table[60][8].yes === 1, "mid ~0.85 at T-60s lands in the 80-90c bucket, and YES won");
  ok(C.table[300][7].n === 1, "mid ~0.705 at T-300s lands in the 70-80c bucket");
}

console.log("\nthe summary");
{
  const S = summary(R);
  ok(S.series[0].series === "KXBTC15M" && S.series[0].snaps === 900 && S.series[0].contracts === 25, "per-series counts");
  ok(S.finalWindow.windows === 1 && S.finalWindow.medianTouchChanges > 0, "touch changes counted in the final two minutes");
  ok(S.index5hz[0].maxGapS === 5, "the longest silence on the index is reported");
  ok(S.gaps === 1 && S.conn.open === 1, "gaps and connection events are counted");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
