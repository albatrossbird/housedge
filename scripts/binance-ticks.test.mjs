// lib/binanceTicks.js — Binance aggTrades as a 5Hz stand-in for BRTI.
import { parseAggTrade, sampleLast } from "../lib/binanceTicks.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// A line copied from BTCUSDT-aggTrades-2026-10-01.zip (microsecond time).
const x = parseAggTrade("4078050863,83623.59000000,0.00038000,6726520262,6726520262,1790812800072804,True,True");
ok(x && x.p === 83623.59 && x.t === 1790812800072, "microseconds become milliseconds", JSON.stringify(x));
ok(parseAggTrade("1,83623.59,0.1,1,1,1790812800072,True,True").t === 1790812800072, "an older file's milliseconds are kept");
ok(parseAggTrade("") === null && parseAggTrade("a,b,c,d,e,f") === null, "a broken line is nothing");

const tr = [{ t: 1050, p: 10 }, { t: 1100, p: 11 }, { t: 1450, p: 12 }];
const s = sampleLast(tr, 1000, 1600, 200);
ok(JSON.stringify(s) === JSON.stringify([{ t: 1200, v: 11 }, { t: 1400, v: 11 }, { t: 1600, v: 12 }]), "each sample is the last trade at or before it; none before the first trade", JSON.stringify(s));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
