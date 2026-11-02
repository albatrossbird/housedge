// lib/m15Tape.js — p75 decided on Kalshi's trade tape. Hand-built trades.
import { parseTrade, tapeEntry, tapePnl, bandOf, firstBuys, pickCell, GRID_BANDS } from "../lib/m15Tape.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

console.log("parseTrade");
// Shape copied from a live /markets/trades reply (2026-11-02).
const raw = { count_fp: "11.00", created_time: "2026-10-01T13:14:58.360508Z", taker_side: "yes", yes_price_dollars: "0.8100", no_price_dollars: "0.1900", ticker: "KXETH15M-26OCT010915-15" };
const p = parseTrade(raw);
ok(p && p.side === "yes" && near(p.price, 0.81) && p.count === 11 && p.t === Date.parse("2026-10-01T13:14:58.360Z"), "a YES buy is priced at the YES price", JSON.stringify(p));
ok(near(parseTrade({ ...raw, taker_side: "no" }).price, 0.19), "a NO buy at the NO price");
ok(parseTrade({ ...raw, taker_side: "" }) === null && parseTrade({ ...raw, yes_price_dollars: "1.0000" }) === null, "no side, or a price of $1, is not a trade we can use");

console.log("tapeEntry");
const close = Date.parse("2026-10-01T13:15:00Z");
const at = (secs, side, price, count = 5) => ({ t: close - secs * 1000, side, price, count });
const trades = [at(50, "yes", 0.80), at(40, "yes", 0.70), at(35, "no", 0.20), at(30, "yes", 0.82), at(20, "no", 0.90), at(10, "yes", 0.95)];
const e = tapeEntry(trades, close);
ok(e && e.side === "yes" && near(e.price, 0.82) && e.t === close - 30000, "the earliest in-band buy inside 15-45s, not the first trade seen", JSON.stringify(e));
ok(tapeEntry([at(46, "yes", 0.80), at(14, "yes", 0.80)], close) === null, "outside 15-45s is ignored");
ok(tapeEntry([at(30, "yes", 0.74), at(30, "yes", 0.98)], close) === null, "outside 75-97c is ignored");
ok(tapeEntry([at(45, "no", 0.75), at(15, "yes", 0.97)], close).side === "no", "the edges are inside the rule");
ok(near(tapeEntry([at(20, "no", 0.90), at(30, "yes", 0.82)], close).price, 0.82), "order of arrival does not matter");

console.log("tapePnl");
ok(near(tapePnl({ side: "yes", price: 0.82 }, "yes", 10, 0.1033), 10 - 8.2 - 0.1033), "won: $1 a contract less cost and fee");
ok(near(tapePnl({ side: "yes", price: 0.82 }, "no", 10, 0.1033), -8.2 - 0.1033), "lost: the cost and fee");

console.log("grid: bandOf");
ok(bandOf(0.03) === 0 && bandOf(0.1999) === 0 && bandOf(0.20) === 1 && bandOf(0.49) === 2, "underdog bands are half-open");
ok(bandOf(0.50) === -1 && bandOf(0.505) === -1 && bandOf(0.02) === -1 && bandOf(0.98) === -1, "50c and the extremes belong to no band");
ok(bandOf(0.51) === 3 && bandOf(0.65) === 4 && bandOf(0.80) === 5 && bandOf(0.97) === 5, "favourite bands, 97c inside the top one as in p75");
ok(GRID_BANDS[bandOf(0.3)].side === "underdog" && GRID_BANDS[bandOf(0.7)].side === "favourite", "the band says which side");

console.log("grid: firstBuys");
{
  const from = close - 600000, tr = [at(605, "yes", 0.6), at(598, "no", 0.41), at(596, "yes", 0.62), at(590, "no", 0.39), at(584, "yes", 0.7)];
  const f = firstBuys(tr, from);
  ok(near(f.yes.price, 0.62) && near(f.no.price, 0.41), "the first buy of each side at or after the point, not before it", JSON.stringify(f));
  ok(firstBuys([at(584, "yes", 0.7)], from).yes === null, "15s later is past the look");
  ok(firstBuys([at(590, "no", 0.39), at(598, "no", 0.41)], from).no.price === 0.41, "order of arrival does not matter");
}

console.log("grid: pickCell");
{
  const c = (key, n, t) => ({ key, train: { n, t } });
  ok(pickCell([c("a", 200, 1.5), c("b", 300, 2.1), c("c", 100, 5)]).key === "b", "highest train t among cells with enough trades");
  ok(pickCell([c("a", 200, 2.1), c("b", 400, 2.1)]).key === "b", "a tie goes to more trades");
  ok(pickCell([c("a", 149, 3)]) === null && pickCell([{ key: "x", train: null }]) === null, "too few trades, or none: no choice");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
