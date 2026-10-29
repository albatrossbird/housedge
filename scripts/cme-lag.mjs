// Does Kalshi's commodity or FX 15-minute book lag the CME future?
// scripts/brti-lag.mjs asks it of Bitcoin and BRTI and found 82% of the
// book's repricing already done when a sharp index move reached the box.
// This asks the same of gold, oil and the rest, with CME's best bid and
// offer each second from Databento (lib/cmeLag.js has the differences).
//
// In each window's final two minutes, where the archive holds every book
// change, take each sharp one-second CME move and measure how far the
// Kalshi book had repriced toward it at -500/0/100/.../5000ms. If most of
// the +5s move is already done at +0, the book moves with CME and there
// is nothing to trade; if it arrives over the next second, that second is
// the opening, before fees.
//
// Two clocks, as brti-lag prints them:
//   EXCHANGE CLOCKS  CME's (Databento ts_recv) against Kalshi's own stamp
//                    on each book change. The cleanest reading of the lag.
//   BOX RECEIVE      the same CME stamp against when the box received each
//                    Kalshi change. A live bot would also wait for the CME
//                    feed to reach it, which this file cannot measure:
//                    read +0 as "+ that feed's delay".
//
// Reads only: the archive (m15/ for gold, m15x/ for the rest) and
// m15_settlements, with the service-role key; the CME path from
// <dir>/ticks/<root>.bbo-1s.csv (scripts/databento-ticks.py).
//
//   node scripts/cme-lag.mjs --series=KXGOLD15M [--dir=databento] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { newTape, feedTape, disrupted, changeRows } from "../lib/m15Maker.js";
import { response, summarise } from "../lib/brtiLag.js";
import { DATABENTO_ROOTS, INVERTED } from "../lib/databento.js";
import { M15_EXTRA_SERIES } from "../lib/m15.js";
import { parseTicks, ticksIn, cmeMoves, cmeOpen } from "../lib/cmeLag.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive and m15_settlements are private (migrations 0029, 0032)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SERIES = String(opt("series", "KXGOLD15M")).toUpperCase();
const ROOT = DATABENTO_ROOTS[SERIES];
if (!ROOT) { console.error(`::error::--series=${SERIES}: not one of ${Object.keys(DATABENTO_ROOTS).join(" ")}`); process.exit(2); }
const DIR = opt("dir", "databento");
const TOP = M15_EXTRA_SERIES.includes(SERIES) ? "m15x" : "m15";
// The archive's clock is trustworthy from 2026-09-30 13:16 UTC (CLAUDE.md,
// "The archive backtest"); the extra series are recorded from 2026-10-26.
const ARCHIVE_FROM = Date.parse(TOP === "m15x" ? "2026-10-26T00:00:00Z" : "2026-09-30T13:16:00Z");
const HORIZONS = [-500, 0, 100, 250, 500, 1000, 2000, 5000];
const THRESHOLDS_BP = [0.5, 1, 2, 4];
const LOOK_MS = 1000;

const tickPath = join(DIR, "ticks", `${ROOT}.bbo-1s.csv`);
if (!existsSync(tickPath)) { console.error(`::error::${tickPath} is missing — run scripts/databento-ticks.py --markets=${ROOT} first`); process.exit(2); }
const T = parseTicks(readFileSync(tickPath, "utf8"), { invert: INVERTED.has(ROOT) });
if (!T.t.length) { console.error(`::error::${tickPath} holds no rows`); process.exit(1); }

const since = opt("since", null), until = opt("until", null);
const FROM = Math.max(ARCHIVE_FROM, T.t[0], since ? Date.parse(`${since}T00:00:00Z`) : -Infinity);
const TO = Math.min(T.t[T.t.length - 1], until ? Date.parse(`${until}T00:00:00Z`) : Infinity);
if (!(TO > FROM)) { console.error(`::error::nothing to compare: CME rows ${new Date(T.t[0]).toISOString()} -> ${new Date(T.t[T.t.length - 1]).toISOString()}, archive from ${new Date(ARCHIVE_FROM).toISOString()}`); process.exit(1); }

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Settled windows whose final two minutes lie inside both records.
const want = new Map();   // ticker -> close (ms)
let shut = 0;
for (const m of await pageAll(rest, "m15_settlements", "ticker,close_time,result",
  `series=eq.${SERIES}&close_time=gte.${new Date(FROM + 125000).toISOString()}&close_time=lte.${new Date(TO - 6000).toISOString()}`,
  { key: "close_time", dedupeOn: "ticker" })) {
  if (m.result !== "yes" && m.result !== "no") continue;
  const close = Date.parse(m.close_time);
  if (!cmeOpen(T, close)) { shut++; continue; }
  want.set(m.ticker, close);
}
const iso = ms => new Date(ms).toISOString().slice(0, 16);
console.log(`CME LAG — ${SERIES} against ${ROOT}${INVERTED.has(ROOT) ? " (inverted)" : ""} front month, Databento bbo-1s mid`);
console.log(`  ${iso(FROM)} -> ${iso(TO)} UTC; ${want.size} settled windows with CME trading in the final two minutes, ${shut} with CME shut (left out)`);
console.log(`  CME rows: ${T.t.length.toLocaleString()}; archive: ${TOP}/`);
if (!want.size) { console.error("::error::no settled windows to replay"); process.exit(1); }

const tapes = { source: newTape(), receive: newTape() };
const results = { source: {}, receive: {} };
for (const c of Object.keys(results)) for (const thr of THRESHOLDS_BP) results[c][thr] = { all: [], near: [] };
const excluded = {};
let windowsUsed = 0, watermark = 0;
const done = new Set();
const perWindow = {};   // thr -> windows with at least one event

function finalize(ticker) {
  done.add(ticker);
  const close = want.get(ticker);
  let ok = true;
  const rowsBy = {};
  for (const [clock, tape] of Object.entries(tapes)) {
    const w = tape.win.get(ticker);
    tape.win.delete(ticker);
    const why = w ? disrupted(tape, w) : "not in the archive";
    if (why) { if (clock === "source") excluded[why] = (excluded[why] || 0) + 1; ok = false; continue; }
    rowsBy[clock] = changeRows(w, { maxSecs: 120 });
  }
  if (!ok) return;
  windowsUsed++;
  const tk = ticksIn(T, close - 125000, close);
  for (const [clock, rows] of Object.entries(rowsBy)) {
    if (!rows.length) continue;
    for (const thr of THRESHOLDS_BP) {
      const evs = cmeMoves(tk, { thrBp: thr, lookMs: LOOK_MS, from: close - 118000, to: close - 6000 });
      if (clock === "source" && evs.length) perWindow[thr] = (perWindow[thr] || 0) + 1;
      for (const ev of evs) {
        const r = response(rows, ev, HORIZONS, { lookMs: LOOK_MS });
        if (!r) continue;
        results[clock][thr].all.push(r);
        if (r.baseMid >= 0.15 && r.baseMid <= 0.85) results[clock][thr].near.push(r);
      }
    }
  }
}

const reader = archiveReader({ url: URL, key: KEY });
const lastClose = Math.max(...want.values());
const files = await reader.listRange(TOP, FROM, lastClose + 3600000);
const keep = line => ((line.startsWith('{"k":"d"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && line.includes(`"m":"${SERIES}-`))
  || line.startsWith('{"k":"conn"') || line.startsWith('{"k":"gap"');
const t0 = Date.now();
let bytes = 0;
for (const f of files) {
  bytes += f.size || 0;
  await reader.eachLine(f.path, o => {
    if (Number.isFinite(o.t) && o.t > watermark) watermark = o.t;
    feedTape(tapes.source, o, want);
    feedTape(tapes.receive, { ...o, x: o.t }, want);
  }, keep);
  // Every window closed more than 10s before the latest line read is complete.
  for (const [ticker, close] of want) if (!done.has(ticker) && close + 10000 < watermark) finalize(ticker);
}
for (const ticker of want.keys()) if (!done.has(ticker)) finalize(ticker);
console.log(`  archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB) in ${Math.round((Date.now() - t0) / 1000)}s; ${windowsUsed} windows replayed; left out ${JSON.stringify(excluded)}`);
if (!windowsUsed) { console.error("::error::no window replayed: nothing below would mean anything"); process.exit(1); }

const sign = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}c`);
const pctS = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
console.log("\nHOW FAST THE KALSHI BOOK FOLLOWS A CME MOVE (final two minutes, every Kalshi book change)");
console.log("  Event: the first CME second whose mid has moved at least N bp from one second before. Moves are measured");
console.log("  from 1s before the event, signed toward CME. \"share\" is the part of the +5s move already done; \"1c\" is how");
console.log("  often the book had moved at least 1c. \"pay\" is the price of the side the move favours (YES ask / NO ask).");
console.log("  The CME row is stamped at the END of its second, so +0 is up to 1s after the move itself (see lib/cmeLag.js).");
for (const [clock, label] of [["source", "EXCHANGE CLOCKS (CME's stamp, Kalshi's stamp)"], ["receive", "BOX RECEIVE CLOCK FOR KALSHI (add the CME feed's own delay)"]]) {
  console.log(`\n  ${label}`);
  for (const thr of THRESHOLDS_BP) for (const subset of ["near", "all"]) {
    const rs = results[clock][thr][subset];
    const sm = summarise(rs, HORIZONS, "mid"), sp = summarise(rs, HORIZONS, "pay");
    const wins = clock === "source" && subset === "near" ? ` (${perWindow[thr] || 0} of ${windowsUsed} windows had one)` : "";
    console.log(`  ${thr}bp in 1s, ${subset === "near" ? "book 15-85c" : "any book"}: ${sm.n} events${wins}`);
    if (!sm.n) continue;
    console.log(`    horizon   ${HORIZONS.map(h => `${h >= 0 ? "+" : ""}${h}ms`.padStart(9)).join("")}`);
    console.log(`    mid       ${sm.rows.map(r => sign(r.mean).padStart(9)).join("")}`);
    console.log(`    share     ${sm.rows.map(r => pctS(r.share).padStart(9)).join("")}`);
    console.log(`    1c        ${sm.rows.map(r => pctS(r.moved1c).padStart(9)).join("")}`);
    console.log(`    pay       ${sp.rows.map(r => sign(r.mean).padStart(9)).join("")}`);
  }
}
console.log(`
READING THIS
- If "share" is already near 100% at +0ms, Kalshi reprices as fast as CME's one-second record shows the move:
  no lag to trade at this resolution. Bitcoin against BRTI measured 82% (CLAUDE.md, "Does the book lag BRTI?").
- "-500ms" is how much Kalshi moved inside the CME second itself, before a one-second feed could know.
- If a large part arrives between +0 and +1000ms, that is the opening, before costs: "pay" at +0 against +5000ms
  is roughly what buying at the event saved per contract. Kalshi's taker fee is ~1.75c near 50c.
- An upper bound in one direction only: a tick-by-tick CME feed would see each move up to a second sooner.`);
