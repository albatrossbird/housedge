// Backtest trading strategies on Kalshi's 15-minute markets, over the
// recorded price path. The engine and its rules are lib/m15Backtest.js;
// this file reads and prints.
//
// Usage:
//   node scripts/m15-backtest.mjs [--days=21] [--size=10] [--strategies=fav-late,momentum|all]
//                                 [--strategy='{"entry":{...},"exit":{...}}' | '{"name":{...},...}']
//                                 [--assume-depth] [SERIES ...]
//
// A custom --strategy is a JSON object shaped like the presets in
// lib/m15Backtest.js. Reads with the service-role key (the recorded
// archives are private, migration 0028) and writes nothing.
//
// Run it ONE AT A TIME, and not 15:45-16:45 UTC while discovery and
// matching run: it reads a window of m15_quotes per settled market.

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { readQuoteWindows } from "../lib/m15Reads.js";
import { toPathRow } from "../lib/m15Backtest.js";
import { strategiesFromArgs, reachSecs, feeMultiplier, printSeriesTable, printFooter, pct } from "../lib/m15BacktestReport.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the recorded archives are private (migration 0028)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Number(opt("days", 21));
const SIZE = Number(opt("size", 10));
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
// The live touch (book_bid/book_ask, depth) exists from this date. Before
// it every price came through a 15s cache (see CLAUDE.md) and there is no
// size at all, so nothing earlier is read.
const BOOK_FROM = Date.parse("2026-09-26T00:00:00Z");
const SINCE = new Date(Math.max(Date.now() - DAYS * 86400000, BOOK_FROM)).toISOString();

let strategies;
try { strategies = strategiesFromArgs(process.argv); }
catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M", "KXGOLD15M");

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const readAll = (table, select, extra, key = "id", dedupeOn = null) =>
  pageAll(rest, table, select, String(extra).replace(/&+$/, ""), { key, dedupeOn });

const fromSecs = reachSecs(strategies);

console.log(`BACKTEST — ${series.join(", ")}, settled since ${SINCE.slice(0, 10)}, ${SIZE} contracts an entry${ASSUME_DEPTH ? ", UNKNOWN DEPTH ASSUMED FILLABLE" : ""}`);
console.log(`strategies: ${Object.keys(strategies).join(", ")}`);

for (const s of series) {
  console.log(`\n${"=".repeat(96)}\n${s}\n${"=".repeat(96)}`);
  const mult = await feeMultiplier(s);
  if (mult == null) { console.log("::warning::could not read fee_multiplier from Kalshi — skipped rather than assuming 1"); continue; }

  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "close_time", "ticker");
  const markets = mk.filter(m => m.result === "yes" || m.result === "no")
    .map(m => ({ ticker: m.ticker, close: Date.parse(m.close_time), result: m.result }));
  if (!markets.length) { console.log("  nothing settled in the window"); continue; }

  const q = await readQuoteWindows(readAll, markets, { fromSecs, toSecs: 0,
    select: "id,ticker,observed_at,secs_to_close,book_bid,book_ask,bid_depth_1c,ask_depth_1c" });
  const paths = new Map();
  for (const r of q) { const p = toPathRow(r); if (!p) continue; if (!paths.has(r.ticker)) paths.set(r.ticker, []); paths.get(r.ticker).push(p); }
  const covered = markets.filter(m => paths.has(m.ticker));
  const yesRate = covered.filter(m => m.result === "yes").length / (covered.length || 1);
  console.log(`fee_multiplier ${mult} | settled markets ${markets.length}, with a recorded live-book path ${covered.length} | settled YES ${pct(yesRate)}`);
  if (!covered.length) continue;

  printSeriesTable({ strategies, covered, paths, size: SIZE, mult, requireDepth: !ASSUME_DEPTH });
}

printFooter({ size: SIZE, fills: "filled at the recorded 15-second quote" });
