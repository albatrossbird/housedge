// The volatility flag on p75 (docs/research/vol-flag-plan.md).
//
//   node scripts/m15-tape-backtest.mjs --series=KXBTC15M --since=2026-07-01 --until=2026-11-15 --size=40 --out=.vol-cache/p75.json
//   node scripts/vol-flag.mjs --p75=.vol-cache/p75.json
//
// Joins each p75 trade to Bitcoin's trailing 2-hour volatility, from
// Kalshi's KXBTC15M settlements (public, no key), and prints the plan's
// verdict. Sharp-move is scored by the same code inside
// scripts/m15-index.mjs (section D6), where its decisions are.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { kxbtc15mReturns, flagReport } from "../lib/volFlagReport.js";

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const P75 = opt("p75", ".vol-cache/p75.json");
const SPLIT = Date.parse(`${opt("split", "2026-09-23")}T00:00:00Z`); // the plan's p75 split
const CACHE = opt("cache", ".vol-cache/returns.json");
const B = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextAt = 0;
async function get(path) {
  for (let i = 0; i < 6; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + 220;
    await sleep(wait);
    const r = await fetch(B + path);
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 90)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 90)}: still refused`);
}

const trades = JSON.parse(readFileSync(P75, "utf8")).map(x => ({ t: x.t, open: x.close - 15 * 60000, pnl: x.pnl, ctrs: x.ctrs }));
const lo = Math.min(...trades.map(x => x.open)) - 86400000 * 2, hi = Math.max(...trades.map(x => x.open)) + 86400000;
let returns;
if (existsSync(CACHE)) {
  const c = JSON.parse(readFileSync(CACHE, "utf8"));
  if (c.lo <= lo && c.hi >= hi) returns = c.returns;
}
if (!returns) {
  returns = await kxbtc15mReturns(get, lo, hi);
  mkdirSync(CACHE.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ lo, hi, returns }));
}
console.log(`returns: ${returns.length} KXBTC15M windows, ${new Date(returns[0].close).toISOString().slice(0, 10)} .. ${new Date(returns.at(-1).close).toISOString().slice(0, 10)}`);
const { lines } = flagReport("p75 (tape, 40 contracts)", trades, returns, SPLIT);
for (const l of lines) console.log(l);
