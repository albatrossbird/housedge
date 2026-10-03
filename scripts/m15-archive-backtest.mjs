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
//                                         [--strategy='{...}'] [--assume-depth] [--maker]
//                                         [--latency-ms=100] [--cutoff-secs=5] [SERIES ...]
//
// --maker also runs every decision as a RESTING order (lib/m15Maker.js):
// a second, sequential pass replays each decided window's final two
// minutes change by change, with its trades, and reports what a bid at
// the touch would have filled — and whether the fills it got were the
// losers.
//
// Reads with the service-role key (the bucket is private, migration
// 0029, and must stay so) and writes nothing.

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { archiveRow, findEntry, runMarket } from "../lib/m15Backtest.js";
import { strategiesFromArgs, reachSecs, seriesFees, printSeriesTable, printFooter, printMakerSection, printMakerFooter, pct } from "../lib/m15BacktestReport.js";
import { newTape, feedTape, disrupted, simulateMaker, checkTradeSides } from "../lib/m15Maker.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 7)), 30);
const SIZE = Number(opt("size", 10));
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
const MAKER = process.argv.includes("--maker");
const LATENCY_MS = Number(opt("latency-ms", 100));
const CUTOFF_SECS = Number(opt("cutoff-secs", 5));
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
// Two at a time: four drew HTTP 429 from Storage on the first real run.
await Promise.all([worker(), worker()]);
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB compressed) in ${Math.round((Date.now() - t0) / 1000)}s, ${kept.toLocaleString()} book lines within ${reach}s of a close${noExchangeTime ? `, ${noExchangeTime} dropped for having no exchange timestamp` : ""}`);

// 3. Resting orders (--maker): every decision the taker backtest makes,
//    executed instead as a bid at the touch, against the final two
//    minutes replayed change by change. One more pass over the files, in
//    order, holding one window at a time.
const fees = new Map();
for (const s of series) fees.set(s, await seriesFees(s));
const maker = new Map();      // `${strategy}|${ticker}` -> { decision, sims: {variant: sim} }
const makerStats = { windows: 0, excluded: {}, sides: { agree: 0, total: 0 } };
const MAKER_VARIANTS = { join: { mode: "join" }, front: { mode: "front" }, improve: { mode: "improve" }, "join+take": { mode: "join", fallback: true } };
if (MAKER) {
  const decisions = new Map();   // ticker -> [{ name, decision }]
  for (const m of wanted.values()) {
    const path = (paths.get(m.ticker) || []).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
    if (!path.length) continue;
    for (const [name, strat] of Object.entries(strategies)) {
      if (strat.exit) continue;   // resting entries are modelled for hold-to-settlement rules only
      const hit = findEntry(strat, m, path, { size: SIZE, requireDepth: !ASSUME_DEPTH });
      if (!hit) continue;
      if (!decisions.has(m.ticker)) decisions.set(m.ticker, []);
      decisions.get(m.ticker).push({ name, decision: { t: hit.row.t, secs: hit.row.secs, side: hit.side, qty: hit.qty, priceMax: strat.entry.priceMax } });
    }
  }
  const want = new Map([...decisions.keys()].map(t => [t, wanted.get(t).close]));
  const tape = newTape();
  const done = new Set();
  const finalize = ticker => {
    done.add(ticker);
    const w = tape.win.get(ticker);
    tape.win.delete(ticker);
    const why = w ? disrupted(tape, w) : "not in the archive";
    if (why) { makerStats.excluded[why] = (makerStats.excluded[why] || 0) + 1; return; }
    makerStats.windows++;
    const c = checkTradeSides(w);
    makerStats.sides.agree += c.agree; makerStats.sides.total += c.total;
    for (const { name, decision } of decisions.get(ticker)) {
      const sims = {};
      for (const [v, o] of Object.entries(MAKER_VARIANTS)) sims[v] = simulateMaker(w, decision, { ...o, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
      maker.set(`${name}|${ticker}`, { decision, sims });
    }
  };
  const tickerNeedle = series.map(s => `"${s}-`);
  const keepM = line => (
    ((line.startsWith('{"k":"d"') || line.startsWith('{"k":"tr"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && needles.some(n => line.includes(n)))
    || (line.startsWith('{"k":"gap"') && tickerNeedle.some(n => line.includes(n)))
    || line.startsWith('{"k":"conn"'));
  const t1 = Date.now();
  let watermark = -Infinity, lines = 0;
  for (const f of files) {
    await reader.eachLine(f.path, o => { lines++; if (Number.isFinite(o.x) && o.x > watermark) watermark = o.x; feedTape(tape, o, want); }, keepM);
    // A window is complete once the record has moved a minute past its close.
    for (const [ticker, close] of want) if (!done.has(ticker) && close + 60000 < watermark) finalize(ticker);
  }
  for (const ticker of want.keys()) if (!done.has(ticker)) finalize(ticker);
  console.log(`resting-order replay: ${makerStats.windows} windows replayed of ${want.size} with a decision, ${lines.toLocaleString()} lines, ${Math.round((Date.now() - t1) / 1000)}s; left out: ${JSON.stringify(makerStats.excluded)}`);
}

// 4. The same report as the poller backtest, per series.
for (const s of series) {
  console.log(`\n${"=".repeat(96)}\n${s}\n${"=".repeat(96)}`);
  const mult = fees.get(s)?.mult ?? null;
  if (mult == null) { console.log("::warning::could not read fee_multiplier from Kalshi — skipped rather than assuming 1"); continue; }
  const markets = [...wanted.values()].filter(m => m.series === s);
  const covered = markets.filter(m => paths.has(m.ticker));
  const days = new Set(covered.map(m => new Date(m.close).toISOString().slice(0, 10)));
  const yesRate = covered.filter(m => m.result === "yes").length / (covered.length || 1);
  console.log(`fee_multiplier ${mult} | settled markets ${markets.length}, with an archived book path ${covered.length} over ${days.size} days | settled YES ${pct(yesRate)}`);
  if (!covered.length) continue;
  printSeriesTable({ strategies, covered, paths, size: SIZE, mult, requireDepth: !ASSUME_DEPTH });
  if (MAKER) printMakerSection({ strategies, covered, paths, size: SIZE, mult, feeType: fees.get(s)?.feeType ?? null,
    requireDepth: !ASSUME_DEPTH, maker, variants: Object.keys(MAKER_VARIANTS), stats: makerStats, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
}

printFooter({ size: SIZE, fills: "filled at the archived once-a-second book" });
if (MAKER) printMakerFooter();
