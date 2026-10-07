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
//                                         [--latency-ms=100] [--cutoff-secs=5] [--venues] [SERIES ...]
//
// --maker also runs every decision as a RESTING order (lib/m15Maker.js):
// a second, sequential pass replays each decided window's final two
// minutes change by change, with its trades, and reports what a bid at
// the touch would have filled — and whether the fills it got were the
// losers.
//
// --venues runs the same rules on Polymarket US's book too, for the
// series it lists (the 15-minute Bitcoin market, lib/m15Venues.js): .us
// alone, and best of both — decided on Kalshi, each contract bought where
// it is cheaper at that second. With --maker as well, the .us decisions
// are replayed as resting orders on the .us tape, where makers are paid.
//
// --preplace keeps a resting bid on the favourite from 60 or 90 seconds
// before the close while each favourite rule's conditions hold, instead
// of posting only when the rule fires (lib/m15Maker.js simulatePrePlace):
// at the bid or a cent below, back or front of the queue, with the
// cancel/replace delay at 100, 250 and 500ms. Beside it, on the SAME
// replayed windows: the rule as a taker and as a decision-time resting
// order. Every settled window is replayed, not only decided ones, since
// a pre-placed bid can fill where the rule never fires.
//
// Reads with the service-role key (the bucket is private, migration
// 0029, and must stay so) and writes nothing.

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { archiveRow, findEntry, runMarket } from "../lib/m15Backtest.js";
import { strategiesFromArgs, reachSecs, seriesFees, printSeriesTable, printFooter, printMakerSection, printMakerFooter, printVenueSection, daysPerYearFor, pct } from "../lib/m15BacktestReport.js";
import { newTape, feedTape, disrupted, simulateMaker, simulatePrePlace, makerTrade, checkTradeSides, snapshotsAt } from "../lib/m15Maker.js";
import { kalshiMakerFee } from "../lib/fees.js";
import { pmusRow, secondly, newUsTape, feedUsTape, resolveUsWindow, VENUE_DELAYS_MS, CLOSED_BOOK } from "../lib/m15Venues.js";
import { parsePmusSlug, kalshiM15Ticker } from "../lib/pmus15.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 7)), 30);
const SIZE = Number(opt("size", 10));
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
const MAKER = process.argv.includes("--maker");
const VENUES = process.argv.includes("--venues");
const PREPLACE = process.argv.includes("--preplace");
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
// --venues also needs this pass: the delay test reads Kalshi's book at
// each delay after a decision from the same change-by-change record.
const decisions = new Map();     // ticker -> [{ name, decision }]
const kSnaps = new Map(), uSnaps = new Map();   // `${strategy}|${ticker}` -> { [delayMs]: book }
const snapsAfter = (w, decision) => {
  const at = snapshotsAt(w, VENUE_DELAYS_MS.map(d => decision.t + d), 10);
  return Object.fromEntries(VENUE_DELAYS_MS.map(d => [d, decision.t + d >= w.close ? CLOSED_BOOK : at.get(decision.t + d)]));
};
// --preplace: the variants, and every result row they produce.
const PRE_VARIANTS = [
  { key: "taker, at the rule", kind: "taker" },
  { key: "resting at the rule, back", kind: "atRule", mode: "join" },
  { key: "resting at the rule, front", kind: "atRule", mode: "front" },
  ...[60, 90].flatMap(postSecs => [
    { key: `from ${postSecs}s, back`, postSecs, mode: "join" },
    { key: `from ${postSecs}s, front`, postSecs, mode: "front" },
    { key: `from ${postSecs}s, 1c below, back`, postSecs, mode: "join", offset: 1 },
    { key: `from ${postSecs}s, 1c below, front`, postSecs, mode: "front", offset: 1 },
    { key: `from ${postSecs}s, back, 250ms`, postSecs, mode: "join", latencyMs: 250 },
    { key: `from ${postSecs}s, back, 500ms`, postSecs, mode: "join", latencyMs: 500 },
  ]),
];
const preRows = [];
const preStats = { windows: 0, excluded: {}, unknownFee: 0 };
const preStrategies = Object.entries(strategies).filter(([, st]) => !st.exit && st.entry?.side === "favourite");
if (PREPLACE && !preStrategies.length) { console.error("::error::--preplace needs a hold-to-settlement favourite rule (e.g. --strategy=paper)"); process.exit(2); }
if (MAKER || VENUES || PREPLACE) {
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
  const want = new Map([...(PREPLACE ? [...wanted.keys()].filter(t => paths.has(t)) : decisions.keys())].map(t => [t, wanted.get(t).close]));
  const tape = newTape();
  const done = new Set();
  const finalize = ticker => {
    done.add(ticker);
    const w = tape.win.get(ticker);
    tape.win.delete(ticker);
    const why = w ? disrupted(tape, w) : "not in the archive";
    const decided = decisions.get(ticker) || [];
    if (why) {
      if (decided.length) makerStats.excluded[why] = (makerStats.excluded[why] || 0) + 1;
      if (PREPLACE) preStats.excluded[why] = (preStats.excluded[why] || 0) + 1;
      return;
    }
    if (PREPLACE) preplaceWindow(ticker, w, decided);
    if (!decided.length) return;
    makerStats.windows++;
    const c = checkTradeSides(w);
    makerStats.sides.agree += c.agree; makerStats.sides.total += c.total;
    for (const { name, decision } of decided) {
      if (VENUES) kSnaps.set(`${name}|${ticker}`, snapsAfter(w, decision));
      if (!MAKER) continue;
      const sims = {};
      for (const [v, o] of Object.entries(MAKER_VARIANTS)) sims[v] = simulateMaker(w, decision, { ...o, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
      maker.set(`${name}|${ticker}`, { decision, sims });
    }
  };
  // One replayed window through every pre-place variant, for every
  // favourite rule. Rows: { series, strategy, variant, close, posted,
  // qty, won, pnl, stale, firstFillSecs, ruleFired }.
  function preplaceWindow(ticker, w, decided) {
    preStats.windows++;
    const m = wanted.get(ticker), fee = fees.get(m.series), mult = fee?.mult ?? 1, feeType = fee?.feeType ?? null;
    const path = (paths.get(ticker) || []).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
    for (const [name, strat] of preStrategies) {
      const decision = decided.find(d => d.name === name)?.decision || null;
      for (const v of PRE_VARIANTS) {
        const row = { series: m.series, strategy: name, variant: v.key, close: m.close, ruleFired: !!decision, posted: false, qty: 0, won: null, pnl: 0, stale: 0, firstFillSecs: null };
        if (v.kind === "taker") {
          const t = decision ? runMarket(strat, m, path, { size: SIZE, mult, requireDepth: !ASSUME_DEPTH }) : null;
          if (t) Object.assign(row, { posted: true, qty: t.qty, won: t.won, pnl: t.pnl, firstFillSecs: t.entrySecs });
        } else if (v.kind === "atRule") {
          if (decision) {
            const sim = simulateMaker(w, decision, { mode: v.mode, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
            if (sim.status === "ok") {
              row.posted = true; row.won = decision.side === m.result;
              const t = makerTrade(m, decision, sim, { mult, feeType });
              if (t) Object.assign(row, { qty: t.qty, pnl: t.pnl, firstFillSecs: sim.firstFillSecs });
              else if (sim.filled) preStats.unknownFee++;
            }
          }
        } else {
          const sim = simulatePrePlace(w, strat.entry, { postSecs: v.postSecs, offset: v.offset || 0, mode: v.mode, latencyMs: v.latencyMs ?? LATENCY_MS, cutoffSecs: CUTOFF_SECS, qty: SIZE });
          if (sim.posts) {
            row.posted = true; row.won = sim.side === m.result;
            if (sim.filled) {
              const mf = kalshiMakerFee(sim.avgPrice, sim.filled, mult, feeType);
              if (mf == null) preStats.unknownFee++;
              else Object.assign(row, { qty: sim.filled, pnl: (row.won ? sim.filled : 0) - sim.cost - mf, stale: sim.stale, firstFillSecs: sim.firstFillSecs });
            }
          }
        }
        preRows.push(row);
      }
    }
  }
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
  console.log(`final-window replay: ${makerStats.windows} windows replayed of ${want.size} with a decision, ${lines.toLocaleString()} lines, ${Math.round((Date.now() - t1) / 1000)}s; left out: ${JSON.stringify(makerStats.excluded)}`);
}

// 3b. Polymarket US (--venues): the .us archive, in order, one window at a
//     time — its book as once-a-second rows for the taker comparison and,
//     with --maker, its tape replayed for resting orders.
const usPaths = new Map();     // kalshi ticker -> .us rows, once a second (the engine's path, like Kalshi's)
const usFull = new Map();      // kalshi ticker -> every .us book within reach: best of both reads the book AT the decision
const usMaker = new Map();     // `${strategy}|${ticker}` -> { decision, sims: { long: {...}, short: {...} } }
const usStats = { windows: 0, excluded: {}, sides: { long: { agree: 0, total: 0 }, short: { agree: 0, total: 0 } } };
if (VENUES) {
  const uFiles = await reader.listRange("pmus15", SINCE_MS - 3600000, Date.now());
  const slugInfo = new Map();   // slug -> { ticker, close } for a settled Kalshi window, else null
  const info = slug => {
    if (!slugInfo.has(slug)) {
      const p = parsePmusSlug(slug), tk = p && kalshiM15Ticker(p.asset, p.close), m = tk && wanted.get(tk);
      slugInfo.set(slug, m ? { ticker: tk, close: m.close } : null);
    }
    return slugInfo.get(slug);
  };
  const usWanted = new Map(), rowsBy = new Map(), tape = newUsTape(), done = new Set();
  const finalizeUs = ticker => {
    done.add(ticker);
    const all = (rowsBy.get(ticker) || []).sort((a, b) => a.t - b.t);
    const rows = secondly(all);
    if (rows.length) { usPaths.set(ticker, rows); usFull.set(ticker, all); }
    const w = tape.win.get(ticker);
    tape.win.delete(ticker);
    const why = w ? disrupted(tape, w) : "not in the .us archive";
    // The delay test: the .us book at each delay after each Kalshi decision.
    if (!why) { const ws = resolveUsWindow(w, "long"); for (const { name, decision } of decisions.get(ticker) || []) uSnaps.set(`${name}|${ticker}`, snapsAfter(ws, decision)); }
    if (!MAKER || !rows.length) return;
    if (why) { usStats.excluded[why] = (usStats.excluded[why] || 0) + 1; return; }
    usStats.windows++;
    const m = wanted.get(ticker);
    const path = rows.filter(r => r.t < m.close && r.secs > 0);
    const resolved = { long: resolveUsWindow(w, "long"), short: resolveUsWindow(w, "short") };
    for (const mode of ["long", "short"]) { const c = checkTradeSides(resolved[mode]); usStats.sides[mode].agree += c.agree; usStats.sides[mode].total += c.total; }
    for (const [name, strat] of Object.entries(strategies)) {
      if (strat.exit) continue;
      const hit = findEntry(strat, m, path, { size: SIZE, requireDepth: !ASSUME_DEPTH });
      if (!hit) continue;
      const decision = { t: hit.row.t, secs: hit.row.secs, side: hit.side, qty: hit.qty, priceMax: strat.entry.priceMax };
      const sims = {};
      for (const mode of ["long", "short"]) {
        sims[mode] = {};
        for (const [v, o] of Object.entries(MAKER_VARIANTS)) sims[mode][v] = simulateMaker(resolved[mode], decision, { ...o, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
      }
      usMaker.set(`${name}|${ticker}`, { decision, sims });
    }
  };
  const keepU = line => line.startsWith('{"k":"pb"') || line.startsWith('{"k":"conn"') || (MAKER && line.startsWith('{"k":"tr"'));
  const t2 = Date.now();
  let watermark = -Infinity, ubytes = 0;
  for (const f of uFiles) {
    ubytes += f.size || 0;
    await reader.eachLine(f.path, o => {
      if (o.k === "conn") { feedUsTape(tape, o, usWanted); return; }
      const inf = typeof o.m === "string" ? info(o.m) : null;
      if (!inf) return;
      if (Number.isFinite(o.x) && o.x > watermark) watermark = o.x;
      if (o.k === "pb") {
        const r = pmusRow(o, inf.close);
        if (r && r.secs <= reach && r.secs > -60) { if (!rowsBy.has(inf.ticker)) rowsBy.set(inf.ticker, []); rowsBy.get(inf.ticker).push(r); }
      }
      usWanted.set(o.m, inf); feedUsTape(tape, o, usWanted);
    }, keepU);
    for (const [slug, inf] of slugInfo) if (inf && !done.has(inf.ticker) && inf.close + 60000 < watermark) finalizeUs(inf.ticker);
  }
  for (const inf of slugInfo.values()) if (inf && !done.has(inf.ticker)) finalizeUs(inf.ticker);
  console.log(`polymarket us: ${uFiles.length} hourly files (${(ubytes / 1e6).toFixed(0)} MB compressed) in ${Math.round((Date.now() - t2) / 1000)}s, ${usPaths.size} settled windows with a .us book path${MAKER ? `; resting-order replay ${usStats.windows} windows, left out ${JSON.stringify(usStats.excluded)}` : ""}`);
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
  printSeriesTable({ strategies, covered, paths, size: SIZE, mult, requireDepth: !ASSUME_DEPTH, daysPerYear: daysPerYearFor(fees.get(s)?.category) });
  if (MAKER) printMakerSection({ strategies, covered, paths, size: SIZE, mult, feeType: fees.get(s)?.feeType ?? null,
    requireDepth: !ASSUME_DEPTH, maker, variants: Object.keys(MAKER_VARIANTS), stats: makerStats, latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS });
  if (VENUES) printVenueSection({ strategies, covered, kPaths: paths, uPaths: usPaths, uFull: usFull, size: SIZE, mult, requireDepth: !ASSUME_DEPTH,
    daysPerYear: daysPerYearFor(fees.get(s)?.category), usMaker: MAKER ? usMaker : null, usStats, variants: Object.keys(MAKER_VARIANTS), latencyMs: LATENCY_MS, cutoffSecs: CUTOFF_SECS,
    delaySnaps: { kalshi: kSnaps, polyus: uSnaps } });
}

if (PREPLACE) printPrePlace();
printFooter({ size: SIZE, fills: "filled at the archived once-a-second book" });
if (MAKER) printMakerFooter();

// --preplace report: per series and favourite rule, every variant on the
// same replayed windows.
function printPrePlace() {
  const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  console.log(`\n${"=".repeat(118)}\nPRE-PLACED RESTING ORDERS — the favourite rules, ${SIZE} contracts, cancelled ${CUTOFF_SECS}s before the close`);
  console.log(`${preStats.windows} windows replayed change by change; left out ${JSON.stringify(preStats.excluded)}${preStats.unknownFee ? `; ::warning::${preStats.unknownFee} fills priced nothing for an unknown fee_type` : ""}`);
  console.log(`${"=".repeat(118)}`);
  for (const s of series) for (const [name] of preStrategies) {
    const rows = preRows.filter(r => r.series === s && r.strategy === name);
    if (!rows.length) continue;
    const days = [...new Set(rows.map(r => day(r.close)))].sort();
    const ruleWindows = new Set(rows.filter(r => r.ruleFired).map(r => r.close)).size;
    const winCount = new Set(rows.map(r => r.close)).size;
    console.log(`\n${s} · ${name} — ${winCount} windows over ${days.length} days; the rule fired in ${ruleWindows}`);
    console.log(`${"variant".padEnd(32)} ${"posted".padStart(6)} ${"filled".padStart(6)} ${"ctrs".padStart(6)} ${"won filled / not".padStart(17)} ${"P&L".padStart(10)} ${"per ctr".padStart(8)} ${"per day".padStart(9)} ${"t(days)".padStart(7)} ${"stale".padStart(6)} ${"fill s".padStart(6)} ${"no rule".padStart(15)}`);
    for (const v of PRE_VARIANTS) {
      const R = rows.filter(r => r.variant === v.key), P = R.filter(r => r.posted), F = P.filter(r => r.qty > 0), U = P.filter(r => r.qty === 0);
      const ctrs = F.reduce((a, r) => a + r.qty, 0), pnl = F.reduce((a, r) => a + r.pnl, 0), stale = F.reduce((a, r) => a + r.stale, 0);
      const wr = A => A.length ? `${(100 * A.filter(r => r.won).length / A.length).toFixed(1)}%` : "—";
      const byDay = days.map(d => F.filter(r => day(r.close) === d).reduce((a, r) => a + r.pnl, 0));
      const mean = byDay.reduce((a, b) => a + b, 0) / days.length;
      const sd = days.length > 1 ? Math.sqrt(byDay.reduce((a, b) => a + (b - mean) ** 2, 0) / (days.length - 1)) : 0;
      const fs = F.map(r => r.firstFillSecs).filter(x => x != null).sort((a, b) => a - b);
      const med = fs.length ? fs[Math.floor(fs.length / 2)].toFixed(0) : "—";
      const extra = F.filter(r => !r.ruleFired);
      console.log(`${v.key.padEnd(32)} ${String(P.length).padStart(6)} ${String(F.length).padStart(6)} ${String(ctrs).padStart(6)} ${`${wr(F)} / ${wr(U)}`.padStart(17)} ${$(pnl).padStart(10)} ${(ctrs ? `${(100 * pnl / ctrs >= 0 ? "+" : "")}${(100 * pnl / ctrs).toFixed(2)}c` : "—").padStart(8)} ${$(mean).padStart(9)} ${(sd > 1e-12 ? (mean / (sd / Math.sqrt(days.length))).toFixed(2) : "—").padStart(7)} ${(ctrs ? `${(100 * stale / ctrs).toFixed(0)}%` : "—").padStart(6)} ${med.padStart(6)} ${(extra.length ? `${extra.length}w ${$(extra.reduce((a, r) => a + r.pnl, 0))}` : "—").padStart(15)}`);
    }
  }
  console.log(`
READING THE PRE-PLACED TABLE
- Every row is the same replayed windows. "taker" buys at the ask when the rule fires; "resting at the rule" posts a bid
  then; "from 60s/90s" keeps a bid on the favourite from that many seconds out while the rule's price band and spread
  hold, re-pegging to the bid as it moves (and losing queue place each time), cancelled ${CUTOFF_SECS}s before the close.
- "back" waits behind everything already at its price; "front" is first in line. The truth is between them.
- "won filled / not": the win rate where the order filled, against where it was posted and never filled. A large gap
  is the market selling to you right before the favourite loses.
- "stale": contracts filled while a cancel or move was still on its way — picked off. "250ms/500ms" rows slow the
  cancel to show what a slower bot pays. "fill s": median seconds before the close at the first fill.
- "no rule": windows filled where the rule itself never fired, and their P&L — trades the taker version never takes.
- Makers pay the series' maker fee (none on fee_type quadratic). Fills are inferred from the recorded trade tape; our
  own order is not in the replayed book and nobody reacts to it. An upper bound like every row here.`);
}
