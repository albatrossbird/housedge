// lib/m15Tape.js — p75 decided on Kalshi's trade tape. Hand-built trades.
import { parseTrade, tapeEntry, tapePnl } from "../lib/m15Tape.js";

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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
