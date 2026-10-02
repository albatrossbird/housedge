// Backtest the 15-minute strategies over the WebSocket ARCHIVE: Kalshi's
// book once a second, timed by the exchange, from the private
// stream-archive bucket (scripts/m15-stream.mjs writes it).
//
// The same engine and rules as scripts/m15-backtest.mjs (lib/m15Backtest.js),
// on a better path:
//   - one book a second where the poller has one every ~15s, which is
//     the difference that matters for rules acting in the final 60s;
//   - it does not depend on the Postgres poller, so a day the poller
//     missed (2026-10-01/02, ~10h) is still here;
//   - Storage reads, not m15_quotes: the only database read is the small
//     list of settled markets and their results.
//
// Usage:
//   node scripts/m15-archive-backtest.mjs [--days=7] [--size=10] [--strategies=...|all]
//                                         [--strategy='{...}'] [--assume-depth] [SERIES ...]
//
// Reads with the service-role key (the bucket is private, migration
// 0029, and must stay so) and writes nothing.

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { archiveRow } from "../lib/m15Backtest.js";
import { strategiesFromArgs, reachSecs, feeMultiplier, printSeriesTable, printFooter, pct } from "../lib/m15BacktestReport.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 7)), 30);
const SIZE = Number(opt("size", 10));
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
const SINCE_MS = Date.now() - DAYS * 86400000;
const SINCE = new Date(SINCE_MS).toISOString();

let strategies;
try { strategies = strategiesFromArgs(process.argv); }
catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M", "KXGOLD15M");
const reach = reachSecs(strategies);

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const readAll = (table, select, extra, key = "id", dedupeOn = null) =>
  pageAll(rest, table, select, String(extra).replace(/&+$/, ""), { key, dedupeOn });

console.log(`ARCHIVE BACKTEST — ${series.join(", ")}, settled since ${SINCE.slice(0, 10)}, ${SIZE} contracts an entry${ASSUME_DEPTH ? ", UNKNOWN DEPTH ASSUMED FILLABLE" : ""}`);
console.log(`strategies: ${Object.keys(strategies).join(", ")}`);

// 1. What settled, and how. Results come from m15_markets (the backfill
//    and the poller write them); the archive records books, not outcomes.
const wanted = new Map();   // ticker -> { ticker, close, result, series }
for (const s of series) {
  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "close_time", "ticker");
  for (const m of mk) if (m.result === "yes" || m.result === "no")
    wanted.set(m.ticker, { ticker: m.ticker, close: Date.parse(m.close_time), result: m.result, series: s });
}
if (!wanted.size) { console.log("nothing settled in the window"); process.exit(0); }

// 2. Every once-a-second book for those markets within reach of the close.
const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 3600000, Date.now());
const needles = series.map(s => `"m":"${s}-`);
const keep = line => line.startsWith('{"k":"b"') && needles.some(n => line.includes(n));
const paths = new Map();
let kept = 0, noExchangeTime = 0, bytes = 0;
const t0 = Date.now();
let next = 0;
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    bytes += f.size || 0;
    await reader.eachLine(f.path, o => {
      const m = wanted.get(o.m);
      if (!m) return;
      const r = archiveRow(o, m.close);
      if (!r) { noExchangeTime++; return; }
      if (r.secs > reach || r.secs < -60) return;
      if (!paths.has(o.m)) paths.set(o.m, []);
      paths.get(o.m).push(r);
      kept++;
    }, keep);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB compressed) in ${Math.round((Date.now() - t0) / 1000)}s, ${kept.toLocaleString()} book lines within ${reach}s of a close${noExchangeTime ? `, ${noExchangeTime} dropped for having no exchange timestamp` : ""}`);

// 3. The same report as the poller backtest, per series.
for (const s of series) {
  console.log(`\n${"=".repeat(96)}\n${s}\n${"=".repeat(96)}`);
  const mult = await feeMultiplier(s);
  if (mult == null) { console.log("::warning::could not read fee_multiplier from Kalshi — skipped rather than assuming 1"); continue; }
  const markets = [...wanted.values()].filter(m => m.series === s);
  const covered = markets.filter(m => paths.has(m.ticker));
  const days = new Set(covered.map(m => new Date(m.close).toISOString().slice(0, 10)));
  const yesRate = covered.filter(m => m.result === "yes").length / (covered.length || 1);
  console.log(`fee_multiplier ${mult} | settled markets ${markets.length}, with an archived book path ${covered.length} over ${days.size} days | settled YES ${pct(yesRate)}`);
  if (!covered.length) continue;
  printSeriesTable({ strategies, covered, paths, size: SIZE, mult, requireDepth: !ASSUME_DEPTH });
}

printFooter({ size: SIZE, fills: "filled at the archived once-a-second book" });
