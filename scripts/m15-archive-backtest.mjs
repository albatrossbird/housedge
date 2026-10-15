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
import { newTape, feedTape, disrupted, simulateMaker, simulatePrePlace, makerTrade, checkTradeSides, snapshotsAt, changeRows } from "../lib/m15Maker.js";
import { kalshiMakerFee, kalshiTakerFee, roundKalshiFee } from "../lib/fees.js";
import { simulateChase, CHASE_VARIANTS, CHASE_DELAYS_MS } from "../lib/m15Chase.js";
import { pmusRow, secondly, newUsTape, feedUsTape, resolveUsWindow, availableAt, bestOfBoth, delayedFill, latestAtOrBefore, VENUE_DELAYS_MS, CLOSED_BOOK } from "../lib/m15Venues.js";
import { pmusTakerFee } from "../lib/venueCompare.js";
import { parsePmusSlug, kalshiM15Ticker } from "../lib/pmus15.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 7)), 30);
// --size=10,30,200: the per-change comparison runs every size; everything
// else runs at the first.
const SIZES = String(opt("size", 10)).split(",").map(Number).filter(n => n > 0);
const SIZE = SIZES[0] ?? 10;
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
const MAKER = process.argv.includes("--maker");
const VENUES = process.argv.includes("--venues");
const PREPLACE = process.argv.includes("--preplace");
// --chase: with --per-change (implied), ways to get MORE fills out of the
// same rule — a limit 1-2c above the price seen, or re-checking the rule
// after a miss (lib/m15Chase.js) — each priced on the book it would meet.
const CHASE = process.argv.includes("--chase");
const PER_CHANGE = process.argv.includes("--per-change") || CHASE;
// --longshot: buy the UNDERDOG in the last seconds, where it is cheap. The
// book a few seconds before the close is often one-sided (the favourite's
// offer gone, its bid at 99c+), which every other mode drops, so these
// lines are kept here on their own. Times are seconds before the close.
const LONGSHOT = process.argv.includes("--longshot");
const LS_TIMES = [15, 10, 5], LS_MAX_SECS = 30, LS_STALE_SECS = 5, LS_CAP = 0.05;
const lsLines = new Map();   // ticker -> [{ t, secs, bid, ask, bidD1, askD1 }] within LS_MAX_SECS of the close
const lsRows = [];
const lsStats = { windows: 0, excluded: {} };
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
let kept = 0, noExchangeTime = 0, oneSided = 0, bytes = 0;
const t0 = Date.now();
let next = 0;
// --path-check: where do each window's snapshot lines fall, by the
// exchange time the engine uses (x) and by when they were written (t)?
const PATH_CHECK = process.argv.includes("--path-check");
const pc = new Map();   // ticker -> counts
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    bytes += f.size || 0;
    await reader.eachLine(f.path, o => {
      const m = wanted.get(o.m);
      if (!m) return;
      if (PATH_CHECK) {
        const c = pc.get(o.m) || pc.set(o.m, { x45: 0, x120: 0, t45: 0, t120: 0, staleMax: 0, stale45: 0 }).get(o.m);
        const xs = Number.isFinite(o.x) ? (m.close - o.x) / 1000 : null, ts = (m.close - o.t) / 1000;
        if (xs != null && xs > 0 && xs <= 45) c.x45++;
        if (xs != null && xs > 0 && xs <= 120) c.x120++;
        if (ts > 0 && ts <= 45) { c.t45++; if (xs != null) { c.staleMax = Math.max(c.staleMax, xs - ts); if (xs > 45) c.stale45++; } }
        if (ts > 0 && ts <= 120) c.t120++;
      }
      if (LONGSHOT && Number.isFinite(o.x) && m.close - o.x > 0 && m.close - o.x <= LS_MAX_SECS * 1000) {
        const v = x => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
        const d = Array.isArray(o.d) ? o.d : [];
        if (!lsLines.has(o.m)) lsLines.set(o.m, []);
        lsLines.get(o.m).push({ t: o.x, secs: (m.close - o.x) / 1000, bid: v(o.b), ask: v(o.a), bidD1: v(d[0]), askD1: v(d[3]) });
      }
      const r = archiveRow(o, m.close);
      // Two different reasons, counted apart: a line from before the
      // recorder stamped exchange time, and a one-sided book (a decided
      // window: a bid at 99c and nothing offered), which has no spread.
      if (!r) { if (!Number.isFinite(o.x)) noExchangeTime++; else oneSided++; return; }
      if (r.secs > reach || r.secs < -60) return;
      if (!paths.has(o.m)) paths.set(o.m, []);
      paths.get(o.m).push(r);
      kept++;
    }, keep);
  }
}
// Two at a time: four drew HTTP 429 from Storage on the first real run.
await Promise.all([worker(), worker()]);
if (PATH_CHECK) {
  for (const s of series) {
    const rows = [...pc].filter(([t]) => wanted.get(t).series === s).map(([, c]) => c);
    const n = rows.length, q = (a, p) => a.length ? a.sort((x, y) => x - y)[Math.floor(p * (a.length - 1))] : null;
    const had = k => rows.filter(c => c[k] > 0).length;
    console.log(`PATH CHECK ${s}: ${n} windows with lines | any line WRITTEN in the last 45s: ${had("t45")}, last 120s: ${had("t120")} | any line STAMPED (x) in the last 45s: ${had("x45")}, last 120s: ${had("x120")}`);
    console.log(`  windows whose last-45s lines all carry an x older than 45s: ${rows.filter(c => c.t45 > 0 && c.x45 === 0).length}; how stale x gets (x age minus write age), median/p90/max of each window's worst: ${q(rows.map(c => c.staleMax), 0.5)?.toFixed(1)}s / ${q(rows.map(c => c.staleMax), 0.9)?.toFixed(1)}s / ${q(rows.map(c => c.staleMax), 1)?.toFixed(1)}s`);
  }
  process.exit(0);
}
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB compressed) in ${Math.round((Date.now() - t0) / 1000)}s, ${kept.toLocaleString()} book lines within ${reach}s of a close${noExchangeTime ? `, ${noExchangeTime} dropped for having no exchange timestamp` : ""}${oneSided ? `, ${oneSided} one-sided books (nothing to buy on one side) left out` : ""}`);

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
// --per-change: the rules whose window sits inside the final-two-minutes
// record, decided on every book change as well as once a second.
const PC_MAX_SECS = 110;
const pcStrategies = Object.entries(strategies).filter(([, st]) => !st.exit && (st.entry?.secsMax ?? 900) + (st.entry?.lookbackSecs ?? 0) <= PC_MAX_SECS);
if (PER_CHANGE && !pcStrategies.length) { console.error(`::error::--per-change needs a hold-to-settlement rule acting within ${PC_MAX_SECS}s of the close (e.g. --strategy=paper)`); process.exit(2); }
const pcRows = [];
const chaseRows = [];
const pcStats = { windows: 0, excluded: {}, usWindows: 0, usExcluded: {} };
// --per-change --venues: each Kalshi change-by-change decision routed
// across both venues for ONE target size (the same money at risk as Kalshi
// alone), every leg a limit at the price seen, filled DELAY ms later.
//   kalshi alone        what the pilot does
//   best of both        cheapest all-in first, spilling at depth
//   + rest on Kalshi    then whatever did not fill, at Kalshi's touch
//   Kalshi + overflow   Kalshi for what its book showed, .us for the rest
const routeRows = [];
function routeAcrossVenues(m, ws, usAll) {
  const mult = fees.get(m.series)?.mult ?? 1;
  const kFee = (p, n) => kalshiTakerFee(p, n, mult), uFee = (p, n) => pmusTakerFee(p, n), feeBy = { kalshi: kFee, polyus: uFee };
  for (const r of pcRows) {
    if (r.venue !== "kalshi" || r.ticker !== m.ticker || !r.pc?.books) continue;
    const d0 = r.pc, strat = Object.fromEntries(pcStrategies)[r.strategy], priceMax = strat.entry?.priceMax ?? 1;
    const uBooks = snapshotsAt(ws, VENUE_DELAYS_MS.map(x => d0.t + x), 10);
    const books = x => ({ kalshi: d0.books[x], polyus: d0.t + x >= m.close ? CLOSED_BOOK : uBooks.get(d0.t + x) });
    const kLeg = [{ venue: "kalshi", price: d0.price, qty: d0.qty }];
    const bob = bestOfBoth({ side: d0.side, t: d0.t, size: r.size, priceMax, requireDepth: !ASSUME_DEPTH, kRow: d0.row, uRows: usAll, kFee, uFee }).legs;
    // Overflow: the rest of the target on .us, at its touch, inside the band.
    const over = [...kLeg];
    const uRow = latestAtOrBefore(usAll, d0.t), left = r.size - d0.qty;
    if (left > 0 && uRow && d0.t - uRow.t <= 2000) {
      const price = d0.side === "yes" ? uRow.ask : Math.round((1 - uRow.bid) * 10000) / 10000, depth = d0.side === "yes" ? uRow.askD1 : uRow.bidD1;
      const n = Math.min(left, Math.floor(depth ?? 0));
      if (price > 0 && price <= priceMax + 1e-9 && n >= 1) over.push({ venue: "polyus", price, qty: n });
    }
    const won = d0.side === m.result, out = {};
    let complete = true;
    for (const [v, legs, fallback] of [["kalshi alone", kLeg, false], ["best of both", bob, false], ["+ rest on Kalshi", bob, true], ["Kalshi + overflow", over, false]]) {
      out[v] = {};
      for (const x of VENUE_DELAYS_MS) {
        const f = legs.length ? delayedFill({ legs, side: d0.side, won, snaps: books(x), priceMax, fees: feeBy, fallback }) : { qty: 0, wanted: 0, pnl: 0, legFills: {} };
        if (!f) { complete = false; break; }
        out[v][x] = { qty: f.qty, wanted: f.wanted, pnl: f.pnl, us: f.legFills?.polyus?.got ?? 0 };
      }
    }
    if (complete) routeRows.push({ series: m.series, strategy: r.strategy, size: r.size, close: m.close, ticker: m.ticker, out });
  }
}
// One venue's window: each rule at each size decided on the once-a-second
// rows and on every book change, and each decision sent as a limit at the
// price it saw, filled against that venue's book DELAY ms later.
function perChangeVenue(venue, m, w, oneRows, changeRowsList) {
  for (const [name, strat] of pcStrategies) for (const size of SIZES) {
    const dec = rows => { const h = findEntry(strat, m, rows, { size, requireDepth: !ASSUME_DEPTH }); return h ? { t: h.row.t, secs: h.row.secs, side: h.side, qty: h.qty, price: h.price, row: h.row } : null; };
    const one = dec(oneRows), pc = dec(changeRowsList);
    const snaps = snapshotsAt(w, [one, pc].filter(Boolean).flatMap(d => VENUE_DELAYS_MS.map(x => d.t + x)), 10);
    const fills = d => d && Object.fromEntries(VENUE_DELAYS_MS.map(x => {
      if (d.t + x >= m.close) return [x, 0];
      const a = availableAt(snaps.get(d.t + x), d.side, d.price);
      return [x, a == null ? null : Math.min(d.qty, Math.floor(a + 1e-9))];
    }));
    if (one) one.fills = fills(one);
    if (pc) pc.fills = fills(pc);
    // The books at each delay, kept for routing the Kalshi decision across
    // both venues once the .us record has been read (printRouting).
    if (pc && venue === "kalshi") pc.books = Object.fromEntries(VENUE_DELAYS_MS.map(x => [x, pc.t + x >= m.close ? CLOSED_BOOK : snaps.get(pc.t + x)]));
    pcRows.push({ venue, size, series: m.series, ticker: m.ticker, strategy: name, close: m.close, result: m.result, one, pc });
  }
}
if (MAKER || VENUES || PREPLACE || PER_CHANGE || LONGSHOT) {
  for (const m of wanted.values()) {
    const path = (paths.get(m.ticker) || []).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
    if (!path.length) continue;
    for (const [name, strat] of Object.entries(strategies)) {
      if (strat.exit) continue;   // resting entries are modelled for hold-to-settlement rules only
      const hit = findEntry(strat, m, path, { size: SIZE, requireDepth: !ASSUME_DEPTH });
      if (!hit) continue;
      if (!decisions.has(m.ticker)) decisions.set(m.ticker, []);
      decisions.get(m.ticker).push({ name, decision: { t: hit.row.t, secs: hit.row.secs, side: hit.side, qty: hit.qty, price: hit.price, priceMax: strat.entry.priceMax } });
    }
  }
  const want = new Map([...(PREPLACE || PER_CHANGE || LONGSHOT ? [...wanted.keys()].filter(t => paths.has(t) || lsLines.has(t)) : decisions.keys())].map(t => [t, wanted.get(t).close]));
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
      if (PER_CHANGE) pcStats.excluded[why] = (pcStats.excluded[why] || 0) + 1;
      if (LONGSHOT) lsStats.excluded[why] = (lsStats.excluded[why] || 0) + 1;
      return;
    }
    if (LONGSHOT) longshotWindow(ticker, w, decided);
    if (PREPLACE) preplaceWindow(ticker, w, decided);
    if (PER_CHANGE) perChangeWindow(ticker, w);
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
  // --longshot: at each time before the close, the underdog's price on the
  // book standing then (no older than LS_STALE_SECS), bought for ONE contract
  // as a limit at that price, filled against the real book 0 and 100ms later.
  function longshotWindow(ticker, w, decided) {
    lsStats.windows++;
    const m = wanted.get(ticker), lines = (lsLines.get(ticker) || []).sort((a, b) => a.t - b.t);
    for (const T of LS_TIMES) {
      let line = null;
      for (const l of lines) if (l.secs >= T) line = l;
      if (!line || line.secs - T > LS_STALE_SECS) continue;
      // The favourite, from whichever side the book still shows.
      const favYes = line.bid != null && line.ask != null ? (line.bid + line.ask) / 2 >= 0.5 : line.bid != null ? line.bid >= 0.5 : line.ask != null ? line.ask > 0.5 : null;
      if (favYes == null) continue;
      const side = favYes ? "no" : "yes";
      const price = favYes ? (line.bid == null ? null : Math.round((1 - line.bid) * 10000) / 10000) : line.ask;
      if (price == null || !(price > 0) || price > LS_CAP + 1e-9) continue;
      const snaps = snapshotsAt(w, [line.t, line.t + 100], 10);
      const fill = x => { const a = availableAt(snaps.get(x), side, price); return a == null ? null : a >= 1; };
      lsRows.push({ series: m.series, close: m.close, T, pilot: decided.length > 0, side, price, won: side === m.result, f0: fill(line.t), f100: fill(line.t + 100) });
    }
  }
  // One replayed window: each rule decided on the once-a-second path (as
  // everywhere else) and on every book change, and each decision sent as
  // a limit at the price it saw, filled against the book DELAY ms later.
  function perChangeWindow(ticker, w) {
    pcStats.windows++;
    const m = wanted.get(ticker);
    const oneRows = (paths.get(ticker) || []).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
    const cRows = changeRows(w, { maxSecs: PC_MAX_SECS + 5 });
    perChangeVenue("kalshi", m, w, oneRows, cRows);
    if (CHASE) for (const [src, rows] of [["one", oneRows], ["pc", cRows]]) {
      const res = simulateChase(w, m, rows, pcStrategies, { size: SIZE, requireDepth: !ASSUME_DEPTH });
      chaseRows.push({ series: m.series, ticker: m.ticker, close: m.close, result: m.result, src, res });
    }
  }
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
    // --per-change: the same rules on the .us book, its every change and its
    // once-a-second path, filled against the .us record.
    if (PER_CHANGE && rows.length) {
      const m = wanted.get(ticker);
      if (why) pcStats.usExcluded[why] = (pcStats.usExcluded[why] || 0) + 1;
      else {
        pcStats.usWindows++;
        const live = r => r.t < m.close && r.secs > 0;
        const ws = resolveUsWindow(w, "long");
        perChangeVenue("polyus", m, ws, rows.filter(live), all.filter(r => live(r) && r.secs <= PC_MAX_SECS + 5));
        routeAcrossVenues(m, ws, all);
      }
    }
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
if (PER_CHANGE) printPerChange();
if (CHASE) printChase();
if (PER_CHANGE && VENUES) { printBothVenues(); printRouting(); }
if (LONGSHOT) printLongshot();
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

// --per-change report: the same windows, each rule decided once a second
// and on every book change, filled at each delay.
function printPerChange() {
  const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const c = (pnl, n) => n ? `${pnl / n >= 0 ? "+" : ""}${(100 * pnl / n).toFixed(2)}c` : "—";
  console.log(`\n${"=".repeat(118)}\nEVERY BOOK CHANGE vs ONCE A SECOND — ${SIZE} contracts, a limit at the price seen, filled against the book DELAY ms later`);
  console.log(`${pcStats.windows} windows replayed change by change; left out ${JSON.stringify(pcStats.excluded)}`);
  console.log(`${"=".repeat(118)}`);
  for (const s of series) for (const [name] of pcStrategies) {
    const R = pcRows.filter(r => r.venue === "kalshi" && r.size === SIZE && r.series === s && r.strategy === name);
    if (!R.length) continue;
    const mult = fees.get(s)?.mult ?? 1;
    const days = [...new Set(R.map(r => day(r.close)))].sort();
    const both = R.filter(r => r.one && r.pc), onlyPc = R.filter(r => r.pc && !r.one), onlyOne = R.filter(r => r.one && !r.pc);
    const earlier = both.map(r => (r.one.t - r.pc.t) / 1000).sort((a, b) => a - b);
    const q = p => earlier.length ? earlier[Math.floor(p * (earlier.length - 1))].toFixed(2) : "—";
    const sameSide = both.filter(r => r.one.side === r.pc.side).length;
    console.log(`\n${s} · ${name} — ${R.length} windows over ${days.length} days`);
    console.log(`  decided once a second: ${R.filter(r => r.one).length} | on every change: ${R.filter(r => r.pc).length} | both: ${both.length} (same side ${sameSide}) | only on a change: ${onlyPc.length} | only once a second: ${onlyOne.length}`);
    console.log(`  where both decided, the change-by-change decision came earlier by (s) median ${q(0.5)}, p10 ${q(0.1)}, p90 ${q(0.9)}`);
    const table = (label, rows, key) => {
      console.log(`  ${label}`);
      console.log(`    ${"delay".padEnd(7)} ${"decided".padStart(7)} ${"filled".padStart(14)} ${"won filled / missed".padStart(20)} ${"P&L".padStart(10)} ${"per ctr".padStart(8)} ${"t(days)".padStart(7)}`);
      for (const d of VENUE_DELAYS_MS) {
        const D = rows.map(r => r[key]).filter(x => x && x.fills[d] != null);
        let want = 0, got = 0, pnl = 0;
        const byDay = new Map(days.map(x => [x, 0]));
        const F = [], M = [];
        for (const r of rows) {
          const x = r[key];
          if (!x || x.fills[d] == null) continue;
          const n = x.fills[d], won = x.side === r.result;
          want += x.qty; got += n;
          (n > 0 ? F : M).push(won);
          if (!n) continue;
          const p = (won ? n : 0) - n * x.price - kalshiTakerFee(x.price, n, mult);
          pnl += p; byDay.set(day(r.close), byDay.get(day(r.close)) + p);
        }
        const v = [...byDay.values()], mean = v.reduce((a, b) => a + b, 0) / v.length;
        const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
        const wr = A => A.length ? `${(100 * A.filter(Boolean).length / A.length).toFixed(1)}%` : "—";
        console.log(`    ${`+${d}ms`.padEnd(7)} ${String(D.length).padStart(7)} ${`${got}/${want} ${want ? (100 * got / want).toFixed(1) : "—"}%`.padStart(14)} ${`${wr(F)} / ${wr(M)}`.padStart(20)} ${$(pnl).padStart(10)} ${c(pnl, got).padStart(8)} ${(sd > 1e-12 ? (mean / (sd / Math.sqrt(v.length))).toFixed(2) : "—").padStart(7)}`);
      }
    };
    table("ONCE A SECOND (the rule as backtested)", R, "one");
    table("EVERY BOOK CHANGE", R, "pc");
    if (onlyPc.length) table(`  of which: the ${onlyPc.length} windows ONLY a change-by-change check traded`, onlyPc, "pc");
  }
  console.log(`
READING THE PER-CHANGE TABLE
- Same windows for both rows: every settled window whose final two minutes were recorded without a gap. "Once a second"
  decides on the archived one-a-second books, as every other figure here; "every book change" on the book after each
  change, changes stamped with the same exchange millisecond taken together.
- Each decision is a limit buy at the price seen, for the contracts it saw within 1c of the touch, filled against the
  real book DELAY ms after the change it decided on — counted from the exchange's own timestamp, so the delay must
  cover the socket, deciding and sending. "+0ms" is the book it decided on: an upper bound nobody gets.
- "won filled / missed": does the market fill you mostly on the ones that lose? "only on a change": windows where a
  sub-second book met the rule and no once-a-second book did — transient books, the question this table exists for.
- An upper bound like every row here: our own order is not in the book, and nobody reacts to it.`);
}

// --chase report: per rule, per decision path (once a second / every change),
// each way of sending the order, at each reply delay — same windows, every
// fill priced at what the book offered up to the order's limit.
function printChase() {
  const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  console.log(`\n${"=".repeat(118)}\nMORE FILLS? — ${SIZE} contract(s), the same decisions sent differently, filled against the book DELAY ms later`);
  console.log(`${"=".repeat(118)}`);
  const label = { one: "ONCE A SECOND", pc: "EVERY BOOK CHANGE" };
  for (const s of series) for (const [name] of pcStrategies) for (const src of ["pc", "one"]) {
    const R = chaseRows.filter(r => r.series === s && r.src === src);
    if (!R.length) continue;
    const mult = fees.get(s)?.mult ?? 1;
    const days = [...new Set(R.map(r => day(r.close)))].sort();
    console.log(`\n${s} · ${name} · ${label[src]} — ${R.length} windows over ${days.length} days`);
    console.log(`  ${"order".padEnd(10)} ${"delay".padEnd(7)} ${"decided".padStart(7)} ${"filled".padStart(14)} ${"tries".padStart(5)} ${"won filled / missed".padStart(20)} ${"avg paid".padStart(8)} ${"P&L".padStart(10)} ${"per ctr".padStart(8)} ${"t(days)".padStart(7)}`);
    for (const v of CHASE_VARIANTS) for (const d of CHASE_DELAYS_MS) {
      let dec = 0, filledW = 0, tries = 0, ctr = 0, paid = 0, pnl = 0;
      const F = [], M = [], byDay = new Map(days.map(x => [x, 0]));
      for (const r of R) {
        const x = r.res[name]?.[v.key]?.[d];
        if (!x || x.unknown) continue;
        dec++; tries += x.tries;
        if (!(x.n > 0)) { M.push(x.side === r.result); continue; }
        const won = x.side === r.result, fee = roundKalshiFee(0.07 * mult * x.pq);
        const p = (won ? x.n : 0) - x.cost - fee;
        filledW++; ctr += x.n; paid += x.cost; pnl += p; F.push(won);
        byDay.set(day(r.close), byDay.get(day(r.close)) + p);
      }
      const vals = [...byDay.values()], mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : 0;
      const wr = A => A.length ? `${(100 * A.filter(Boolean).length / A.length).toFixed(1)}%` : "—";
      console.log(`  ${v.key.padEnd(10)} ${`+${d}ms`.padEnd(7)} ${String(dec).padStart(7)} ${`${filledW} ${dec ? (100 * filledW / dec).toFixed(1) : "—"}%`.padStart(14)} ${(dec ? (tries / dec).toFixed(2) : "—").padStart(5)} ${`${wr(F)} / ${wr(M)}`.padStart(20)} ${(ctr ? (paid / ctr).toFixed(4) : "—").padStart(8)} ${$(pnl).padStart(10)} ${(ctr ? `${pnl / ctr >= 0 ? "+" : ""}${(100 * pnl / ctr).toFixed(2)}c` : "—").padStart(8)} ${(sd > 1e-12 ? (mean / (sd / Math.sqrt(vals.length))).toFixed(2) : "—").padStart(7)}`);
    }
  }
  console.log(`
READING THE MORE-FILLS TABLE
- Same windows and the same first decision for every row; only how the order is sent differs. "base" is one limit at the
  price seen. "chase+Nc" puts the limit N cents above it, never above the rule's price cap, and pays what the book offered
  up to that limit. "retry" re-checks the rule from the moment a miss came back and sends the next qualifying moment the
  same way, until a fill or the rule's window closes ("tries" = orders sent per decided window). Every row pays the walked
  price, so "base" here can read slightly better than the per-change table, which charges the price seen.
- "won filled / missed": if the missed windows win MORE often than the filled ones, misses are costing winners and a way
  to fill them may pay; if they win less, the misses were protecting you.
- Upper bounds like every row here: our order is not in the book and nobody reacts to it.`);
}

// --per-change --venues: the rule run on Kalshi and on Polymarket US at the
// same time, each on its own book, each venue's own fees — not best of
// both — on the windows both venues' records cover cleanly. "both" is the
// two accounts added together, so it is twice the exposure per window.
function printBothVenues() {
  const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const fee = { kalshi: (p, n, s) => kalshiTakerFee(p, n, fees.get(s)?.mult ?? 1), polyus: (p, n) => pmusTakerFee(p, n) };
  const SHOW = [0, 50, 100, 250];
  console.log(`\n${"=".repeat(118)}\nBOTH VENUES AT ONCE — each runs the rule on its own book; "both" is the two added together (not best of both)`);
  console.log(`Kalshi windows replayed ${pcStats.windows} (left out ${JSON.stringify(pcStats.excluded)}); .us windows ${pcStats.usWindows} (left out ${JSON.stringify(pcStats.usExcluded)})`);
  console.log(`${"=".repeat(118)}`);
  for (const s of series) for (const [name] of pcStrategies) for (const size of SIZES) {
    const k = new Map(pcRows.filter(r => r.venue === "kalshi" && r.series === s && r.strategy === name && r.size === size).map(r => [r.ticker, r]));
    const u = new Map(pcRows.filter(r => r.venue === "polyus" && r.series === s && r.strategy === name && r.size === size).map(r => [r.ticker, r]));
    const common = [...k.keys()].filter(t => u.has(t));
    if (!common.length) continue;
    const days = [...new Set(common.map(t => day(k.get(t).close)))].sort();
    console.log(`\n${s} · ${name} · ${size} contracts an entry on each venue — ${common.length} windows both venues covered, over ${days.length} days`);
    console.log(`  ${"decides on".padEnd(16)} ${"venue".padEnd(7)} ${"decided".padStart(7)} ${SHOW.map(d => `${`+${d}ms P&L (filled)`.padStart(22)}`).join("")} ${"per ctr @100".padStart(13)} ${"t @100".padStart(7)}`);
    for (const key of ["one", "pc"]) {
      for (const v of ["kalshi", "polyus", "both"]) {
        const venues = v === "both" ? ["kalshi", "polyus"] : [v];
        let decided = 0;
        const cells = [];
        let per100 = "—", t100 = "—";
        for (const d of SHOW) {
          let got = 0, want = 0, pnl = 0, known = 0;
          const byDay = new Map(days.map(x => [x, 0]));
          for (const t of common) {
            for (const vv of venues) {
              const x = (vv === "kalshi" ? k : u).get(t)[key];
              if (!x) continue;
              if (d === SHOW[0]) decided++;
              const n = x.fills[d];
              if (n == null) continue;
              known++; want += x.qty; got += n;
              if (!n) continue;
              const r = k.get(t), won = x.side === r.result;
              const p = (won ? n : 0) - n * x.price - fee[vv](x.price, n, s);
              pnl += p; byDay.set(day(r.close), byDay.get(day(r.close)) + p);
            }
          }
          cells.push(`${$(pnl)} (${want ? (100 * got / want).toFixed(0) : "—"}%)`.padStart(22));
          if (d === 100) {
            const vals = [...byDay.values()], mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : 0;
            per100 = got ? `${pnl / got >= 0 ? "+" : ""}${(100 * pnl / got).toFixed(2)}c` : "—";
            t100 = sd > 1e-12 ? (mean / (sd / Math.sqrt(vals.length))).toFixed(2) : "—";
          }
        }
        console.log(`  ${(key === "one" ? "once a second" : "every change").padEnd(16)} ${v.padEnd(7)} ${String(decided).padStart(7)} ${cells.join("")} ${per100.padStart(13)} ${t100.padStart(7)}`);
      }
    }
  }
  console.log(`
READING THE BOTH-VENUES TABLE
- Each venue decides on its OWN book (its own price, spread and depth) and is charged its own taker fee: Kalshi's
  rounded up per order, .us's half-even. A window can trade on one venue and not the other.
- "both" adds the two accounts: up to twice the contracts per window, and twice the exposure when both fire on the
  same side — which they usually do, because it is the same market. It is not diversification.
- Size is the most a decision buys: what sits within 1c of the touch, capped at the size, filled as a limit at the
  price seen against the book DELAY ms later. An upper bound: our order is not in the replayed book.`);
}

// --per-change --venues: one target size routed across the two venues.
function printRouting() {
  const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const SHOW = [0, 50, 100, 250, 500];
  const V = ["kalshi alone", "best of both", "+ rest on Kalshi", "Kalshi + overflow"];
  console.log(`\n${"=".repeat(118)}\nONE TARGET SIZE ACROSS BOTH VENUES — Kalshi's every-change decision, the same money at risk as Kalshi alone`);
  console.log(`${"=".repeat(118)}`);
  for (const s of series) for (const [name] of pcStrategies) for (const size of SIZES) {
    const R = routeRows.filter(r => r.series === s && r.strategy === name && r.size === size);
    if (!R.length) continue;
    const days = [...new Set(R.map(r => day(r.close)))].sort();
    console.log(`\n${s} · ${name} · target ${size} contracts — ${R.length} decisions both venues' books cover, over ${days.length} days`);
    console.log(`  ${"routing".padEnd(18)} ${SHOW.map(d => `${`+${d}ms P&L (filled, on .us)`.padStart(30)}`).join("")} ${"per ctr @100".padStart(13)} ${"t @100".padStart(7)}`);
    for (const v of V) {
      let per100 = "—", t100 = "—";
      const cells = SHOW.map(d => {
        let q = 0, w = 0, pnl = 0, us = 0;
        const byDay = new Map(days.map(x => [x, 0]));
        for (const r of R) { const o = r.out[v][d]; q += o.qty; w += o.wanted; pnl += o.pnl; us += o.us; byDay.set(day(r.close), byDay.get(day(r.close)) + o.pnl); }
        if (d === 100) {
          const vals = [...byDay.values()], mean = vals.reduce((a, b) => a + b, 0) / vals.length;
          const sd = vals.length > 1 ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)) : 0;
          per100 = q ? `${pnl / q >= 0 ? "+" : ""}${(100 * pnl / q).toFixed(2)}c` : "—";
          t100 = sd > 1e-12 ? (mean / (sd / Math.sqrt(vals.length))).toFixed(2) : "—";
        }
        return `${$(pnl)} (${w ? (100 * q / w).toFixed(0) : "—"}%, ${q ? (100 * us / q).toFixed(0) : 0}%)`.padStart(30);
      });
      console.log(`  ${v.padEnd(18)} ${cells.join("")} ${per100.padStart(13)} ${t100.padStart(7)}`);
    }
  }
  console.log(`
READING THE ROUTING TABLE
- Every row is the SAME Kalshi decisions at the SAME target size, so the same most-at-risk per window: only where the
  contracts come from differs. "filled" is contracts filled over the target the book showed; "on .us" is the share
  of filled contracts bought on Polymarket US.
- "best of both" takes the cheaper venue all-in first and spills to the other at its depth; "+ rest on Kalshi" then
  buys what did not fill at Kalshi's touch when the orders land, inside the rule's price cap; "Kalshi + overflow"
  sends Kalshi what its book showed and only the remainder to .us. A .us book over 2s old is not used.
- Limits at the prices seen, filled against each venue's book DELAY ms after the decision; upper bounds as everywhere.`);
}

// --longshot report: is the underdog in the last seconds worth what it costs?
// One contract a window, held to settlement, Kalshi's taker fee at $0.0001.
function printLongshot() {
  const BUCKETS = [["0.1-0.9c", 0, 0.0095], ["1c", 0.0095, 0.0105], ["1.1-2c", 0.0105, 0.0205], ["2.1-5c", 0.0205, LS_CAP + 1e-9]];
  const wilson = (k, n) => { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - r) / d, (c + r) / d]; };
  const pc = x => (x == null ? "—" : `${(100 * x).toFixed(2)}%`);
  console.log(`\n${"=".repeat(118)}\nTHE UNDERDOG IN THE LAST SECONDS — one contract at its ask (${LS_CAP * 100}c or less), held to settlement`);
  console.log(`${lsStats.windows} windows replayed; left out ${JSON.stringify(lsStats.excluded)}`);
  console.log(`${"=".repeat(118)}`);
  for (const s of series) {
    const mult = fees.get(s)?.mult ?? 1;
    for (const T of LS_TIMES) for (const [g, f] of [["every window", () => true], ["the pilot did NOT trade", r => !r.pilot], ["the pilot DID trade (a hedge)", r => r.pilot]]) {
      const R = lsRows.filter(r => r.series === s && r.T === T && f(r));
      if (!R.length) continue;
      console.log(`\n${s} · ${T}s before the close · ${g}`);
      console.log(`  ${"price".padEnd(9)} ${"offered".padStart(7)} ${"filled +100ms".padStart(13)} ${"avg paid".padStart(9)} ${"needs".padStart(7)} ${"won".padStart(7)} ${"won range (95%)".padStart(17)} ${"P&L".padStart(9)} ${"per ctr".padStart(8)}`);
      for (const [label, lo, hi] of [...BUCKETS, ["all", 0, LS_CAP + 1e-9]]) {
        const B = R.filter(r => r.price > lo && r.price <= hi), F = B.filter(r => r.f100);
        if (!B.length) continue;
        const won = F.filter(r => r.won).length, paid = F.reduce((a, r) => a + r.price, 0), fee = F.reduce((a, r) => a + kalshiTakerFee(r.price, 1, mult), 0);
        const pnl = won - paid - fee, [lo95, hi95] = wilson(won, F.length);
        console.log(`  ${label.padEnd(9)} ${String(B.length).padStart(7)} ${String(F.length).padStart(13)} ${(F.length ? `${(100 * paid / F.length).toFixed(2)}c` : "—").padStart(9)} ${(F.length ? pc((paid + fee) / F.length) : "—").padStart(7)} ${(F.length ? pc(won / F.length) : "—").padStart(7)} ${(lo95 == null ? "—" : `[${pc(lo95)}, ${pc(hi95)}]`).padStart(17)} ${`${pnl < 0 ? "-" : "+"}$${Math.abs(pnl).toFixed(2)}`.padStart(9)} ${(F.length ? `${(100 * pnl / F.length).toFixed(2)}c` : "—").padStart(8)}`);
      }
    }
  }
  console.log(`
READING THE UNDERDOG TABLE
- "offered": windows where the underdog could be bought at ${LS_CAP * 100}c or less at that moment (from the book standing
  then, one-sided books included); "filled": a 1-contract limit at that price still filled 100ms later.
- "needs" is price + fee: the win rate at which the bet breaks even. The bet pays only if "won" is clearly above it;
  the won range is a Wilson interval, and at these prices a handful of wins moves it a lot.
- "the pilot DID trade" is the hedge reading: the underdog wins exactly when the pilot's favourite loses, so a
  negative row here is what the insurance costs per window, not a separate loss.
- Kalshi prices this market in 0.1c steps below 10c (tapered_deci_cent), so 0.1c is the lowest price.`);
}
