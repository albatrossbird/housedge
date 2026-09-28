// The live order book kept from Kalshi's WebSocket, pinned.
//
// The snapshot fixture is the one in Kalshi's own AsyncAPI spec
// (FED-23DEC-T3.00), in the legacy no-leg encoding it is printed in.
// Every other case is derived from it, so a misreading of the spec shows
// up as a disagreement with the spec's own example.

import { BookSet } from "../lib/kalshiBook.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Straight from docs.kalshi.com's orderbook_snapshot example. NO side in
// NO-LEG pricing: NO bids at 0.54 and 0.56 are YES offers at 0.46, 0.44.
const SPEC_SNAPSHOT = { type: "orderbook_snapshot", sid: 2, seq: 2, msg: {
  market_ticker: "FED-23DEC-T3.00",
  yes_dollars_fp: [["0.0800", "300.00"], ["0.2200", "333.00"]],
  no_dollars_fp:  [["0.5400", "20.00"],  ["0.5600", "146.00"]],
}};
// The SAME book in yes-leg pricing, as `use_yes_price: true` delivers it.
const YES_LEG_SNAPSHOT = { ...SPEC_SNAPSHOT, msg: { ...SPEC_SNAPSHOT.msg,
  no_dollars_fp: [["0.4600", "20.00"], ["0.4400", "146.00"]] } };

console.log("the spec's own snapshot");
{
  const b = new BookSet({ yesLeg: false }); b.apply(SPEC_SNAPSHOT);
  const t = b.touch("FED-23DEC-T3.00");
  ok(t.bid === 0.22 && t.bidSize === 333, "best YES bid 0.22 x 333 — the HIGHEST yes level, not the first");
  ok(t.ask === 0.44 && t.askSize === 146, "best YES ask 0.44 x 146 — the highest NO bid (0.56), mirrored");
  ok(t.bid < t.ask, "not crossed");
}

console.log("\nboth encodings of one market give the IDENTICAL book");
{
  // This is the test that protects the default flip. If the flag and the
  // interpretation ever disagree, one of these two books is wrong, and
  // the day Kalshi flips the default is the day it would start.
  const legacy = new BookSet({ yesLeg: false }); legacy.apply(SPEC_SNAPSHOT);
  const yesLeg = new BookSet({ yesLeg: true });  yesLeg.apply(YES_LEG_SNAPSHOT);
  const T = "FED-23DEC-T3.00";
  ok(same(legacy.touch(T), yesLeg.touch(T)), "same touch");
  ok(same(legacy.depth(T), yesLeg.depth(T)), "same depth");
  ok(same(legacy.levels(T), yesLeg.levels(T)), "same ladder");
  // And the failure it guards against: yes-leg data read as legacy puts
  // the offers at 0.54/0.56 — a plausible-looking, entirely wrong book.
  const wrong = new BookSet({ yesLeg: false }); wrong.apply(YES_LEG_SNAPSHOT);
  ok(wrong.touch(T).ask === 0.54, "control: yes-leg data read as legacy lands the ask at 0.54, not 0.44");
  ok(wrong.touch(T).bid < wrong.touch(T).ask, "...and is NOT crossed — which is why a crossed-book check alone cannot catch it");
}

console.log("\ndeltas are changes in size, not sizes");
{
  const b = new BookSet({ yesLeg: true }); b.apply(YES_LEG_SNAPSHOT);
  const T = "FED-23DEC-T3.00";
  b.apply({ type: "orderbook_delta", sid: 2, seq: 3, msg: { market_ticker: T, price_dollars: "0.2200", delta_fp: "-33.00", side: "yes", ts_ms: 1710000000123 } });
  ok(b.touch(T).bidSize === 300, "333 - 33 = 300 at the touch");
  ok(b.touch(T).tsMs === 1710000000123, "the EXCHANGE timestamp is kept, not our receive time");
  b.apply({ type: "orderbook_delta", sid: 2, seq: 4, msg: { market_ticker: T, price_dollars: "0.2200", delta_fp: "-300.00", side: "yes" } });
  ok(b.touch(T).bid === 0.08, "a level taken to zero is removed; the next level becomes the touch");
  b.apply({ type: "orderbook_delta", sid: 2, seq: 5, msg: { market_ticker: T, price_dollars: "0.4300", delta_fp: "50.00", side: "no" } });
  ok(b.touch(T).ask === 0.43 && b.touch(T).askSize === 50, "a new NO level (yes-leg 0.43) becomes the best ask");
}

console.log("\na sequence gap makes the book UNKNOWN until re-snapshotted");
{
  const b = new BookSet({ yesLeg: true }); b.apply(YES_LEG_SNAPSHOT);
  const T = "FED-23DEC-T3.00";
  const r = b.apply({ type: "orderbook_delta", sid: 2, seq: 7, msg: { market_ticker: T, price_dollars: "0.2200", delta_fp: "-1.00", side: "yes" } });
  ok(r.gap && r.gap.expected === 3 && r.gap.got === 7, "the gap is reported: expected 3, got 7");
  ok(same(r.gap.tickers, [T]), "...naming every market on that subscription, so the caller can re-snapshot them");
  ok(b.touch(T) === null, "the book reads as UNKNOWN, not as its last state");
  ok(b.depth(T) === null && b.levels(T) === null, "and so do depth and the ladder");
  b.apply({ type: "orderbook_delta", sid: 2, seq: 8, msg: { market_ticker: T, price_dollars: "0.2200", delta_fp: "5.00", side: "yes" } });
  ok(b.stats.droppedUntrusted === 2, "deltas on an untrusted book are dropped, not applied to a book known to be incomplete");
  b.apply({ ...YES_LEG_SNAPSHOT, seq: 9 });
  ok(b.isFresh(T) && b.touch(T).bid === 0.22, "a fresh snapshot restores it");
}

console.log("\nseq is per SUBSCRIPTION, not global");
{
  const b = new BookSet({ yesLeg: true });
  b.apply({ ...YES_LEG_SNAPSHOT, sid: 2, seq: 1 });
  const r = b.apply({ type: "orderbook_snapshot", sid: 5, seq: 1, msg: { market_ticker: "OTHER", yes_dollars_fp: [["0.5", "1"]], no_dollars_fp: [] } });
  ok(!r.gap, "a different sid starting at 1 is not a gap");
  ok(b.touch("OTHER").ask === null && b.touch("OTHER").askSize === 0, "an empty side: no price, size 0 — fetched and empty");
}

console.log("\ndepth uses the polling recorder's definition");
{
  const b = new BookSet({ yesLeg: true });
  b.apply({ type: "orderbook_snapshot", sid: 1, seq: 1, msg: { market_ticker: "X",
    yes_dollars_fp: [["0.3700", "10"], ["0.3800", "30"], ["0.3690", "5"]],
    no_dollars_fp: [["0.3900", "7"], ["0.4000", "8"], ["0.4400", "9"]] } });
  const d = b.depth("X");
  ok(d.bid_1c === 40, "bid within 1c, touch inclusive: 0.38 + 0.37 (0.369 is 1.1c away)");
  ok(d.ask_1c === 15 && d.ask_5c === 24, "ask within 1c and 5c, measured upward from the best ask");
}

console.log("\nKalshi's ok reply to add/delete consumes a sequence number");
{
  // Measured on the box 2026-09-28: every add_markets and delete_markets
  // showed up as a one-number gap until `ok` was counted.
  const bs = new BookSet({ yesLeg: true });
  const snap = (seq, t) => ({ type: "orderbook_snapshot", sid: 1, seq, msg: { market_ticker: t, yes_dollars_fp: [["0.4000", "10"]], no_dollars_fp: [["0.5500", "10"]] } });
  const delta = seq => ({ type: "orderbook_delta", sid: 1, seq, msg: { market_ticker: "A", side: "yes", price_dollars: "0.4000", delta_fp: "1" } });
  bs.apply(snap(1, "A")); bs.apply(delta(2));
  const okR = bs.apply({ id: 9, type: "ok", sid: 1, seq: 3, msg: { market_tickers: ["A", "B"] } });
  bs.apply(snap(4, "B"));
  const d = bs.apply(delta(5));
  ok(!okR.gap && !d.gap && bs.stats.gaps === 0 && bs.isFresh("A"), "an ok between frames is not a gap");
  const other = bs.apply({ id: 10, type: "ok", sid: 2, seq: 7, msg: {} });
  ok(!other.gap && !bs.lastSeq.has(2), "an ok on a subscription the book does not follow (trades) is ignored");
  const g = bs.apply(delta(7));
  ok(g.gap?.expected === 6, "a real missing frame is still a gap");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
