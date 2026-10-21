// Does Kalshi's KXBTC15M book lag BRTI, the index it settles on?
//
// Two readings from the WebSocket archive (lib/brtiLag.js has the maths):
//
//   1. FEED DELAY. How late each feed reaches the box: receive time (t)
//      minus the source's own stamp (x), for BRTI's 5Hz ticks (CF
//      Benchmarks' source_ts_ms, relayed by Kalshi) and for Kalshi's book
//      changes (ts_ms). The two sources run different clocks, so a
//      difference between them is part delay, part clock offset.
//   2. RESPONSE. In each window's final two minutes, where every book
//      change is recorded, take each sharp BRTI move and measure how far
//      the book had repriced toward it at +0/100/250/500/1000/2000/5000ms.
//      Done twice: on the sources' own clocks, and on the box's receive
//      clock — the second is what a bot on this box would actually see.
//
// Reads only. Needs SUPABASE_SERVICE_ROLE_KEY (the archive is private).
// Usage: node scripts/brti-lag.mjs [--days=7]

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { newTape, feedTape, disrupted, changeRows } from "../lib/m15Maker.js";
import { findMoves, response, summarise } from "../lib/brtiLag.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Math.min(Number(opt("days", 7)), 30);
const SINCE_MS = Date.now() - DAYS * 86400000;
const SERIES = "KXBTC15M";
const HORIZONS = [-500, 0, 100, 250, 500, 1000, 2000, 5000];
const THRESHOLDS_BP = [1, 2, 4];
const LOOK_MS = 1000;

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const want = new Map();   // ticker -> close (ms)
for (const m of await pageAll(rest, "m15_markets", "ticker,close_time,result",
  `series=eq.${SERIES}&result=not.is.null&close_time=gte.${new Date(SINCE_MS).toISOString()}`, { key: "close_time", dedupeOn: "ticker" }))
  if (m.result === "yes" || m.result === "no") want.set(m.ticker, Date.parse(m.close_time));
console.log(`BRTI LAG — ${SERIES}, ${want.size} settled windows since ${new Date(SINCE_MS).toISOString().slice(0, 10)}`);

// Delay samples, capped by reservoir so a month fits in memory.
const CAP = 1_000_000;
function reservoir() { return { a: [], n: 0 }; }
function sample(r, v) { r.n++; if (r.a.length < CAP) r.a.push(v); else { const j = Math.floor(Math.random() * r.n); if (j < CAP) r.a[j] = v; } }
const delay = { brti: reservoir(), book: reservoir() };
const spacing = { n: 0, over1s: 0, over5s: 0, prevX: null };

const tapes = { source: newTape(), receive: newTape() };
let ticks = [];   // BRTI { x, t, v }, recent only
const results = { source: {}, receive: {} };
for (const c of Object.keys(results)) for (const thr of THRESHOLDS_BP) results[c][thr] = { all: [], near: [] };
const excluded = {};
let windowsUsed = 0, watermark = 0;
const done = new Set();

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
  for (const [clock, rows] of Object.entries(rowsBy)) {
    if (!rows.length) continue;
    const key = clock === "source" ? "x" : "t";
    const tk = ticks.filter(k => k[key] >= close - 125000 && k[key] <= close).map(k => ({ t: k[key], v: k.v })).sort((a, b) => a.t - b.t);
    for (const thr of THRESHOLDS_BP) {
      const evs = findMoves(tk, { thrBp: thr, lookMs: LOOK_MS, from: close - 118000, to: close - 6000 });
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
const files = await reader.listRange("m15", SINCE_MS - 3600000, Date.now());
const keep = line => (line.startsWith('{"k":"i5"') && line.includes('"id":"BRTI"'))
  || ((line.startsWith('{"k":"d"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && line.includes(`"m":"${SERIES}-`))
  || line.startsWith('{"k":"conn"') || line.startsWith('{"k":"gap"');
const t0 = Date.now();
let bytes = 0;
for (const f of files) {
  bytes += f.size || 0;
  await reader.eachLine(f.path, o => {
    if (Number.isFinite(o.t) && o.t > watermark) watermark = o.t;
    if (o.k === "i5") {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.v)) return;
      sample(delay.brti, o.t - o.x);
      if (spacing.prevX != null && o.x > spacing.prevX) { spacing.n++; const g = o.x - spacing.prevX; if (g > 1000) spacing.over1s++; if (g > 5000) spacing.over5s++; }
      if (spacing.prevX == null || o.x > spacing.prevX) spacing.prevX = o.x;
      ticks.push({ x: o.x, t: o.t, v: o.v });
      return;
    }
    if (o.k === "d" && Number.isFinite(o.x)) sample(delay.book, o.t - o.x);
    feedTape(tapes.source, o, want);
    feedTape(tapes.receive, { ...o, x: o.t }, want);
  }, keep);
  // Every window closed more than 10s before the latest line read is complete.
  for (const [ticker, close] of want) if (!done.has(ticker) && close + 10000 < watermark) finalize(ticker);
  ticks = ticks.filter(k => k.t >= watermark - 1800000);
}
for (const ticker of want.keys()) if (!done.has(ticker)) finalize(ticker);
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB) in ${Math.round((Date.now() - t0) / 1000)}s; ${windowsUsed} windows replayed; left out ${JSON.stringify(excluded)}`);

const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = v => (v == null ? "—" : `${Math.round(v)}ms`);
console.log("\n1. FEED DELAY — box receive time minus the source's own stamp");
console.log("   feed                       n        p10      p50      p90      p99");
for (const [name, r] of [["BRTI 5Hz (CF Benchmarks)", delay.brti], ["Kalshi book changes", delay.book]])
  console.log(`   ${name.padEnd(24)} ${String(r.n).padStart(9)}  ${fmt(q(r.a, 0.1)).padStart(7)}  ${fmt(q(r.a, 0.5)).padStart(7)}  ${fmt(q(r.a, 0.9)).padStart(7)}  ${fmt(q(r.a, 0.99)).padStart(7)}`);
console.log(`   BRTI tick spacing: ${spacing.n.toLocaleString()} gaps, ${spacing.over1s} over 1s, ${spacing.over5s} over 5s`);
console.log("   The two sources stamp on different clocks, so the gap between their delays is delay plus clock offset.");

const sign = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}c`);
const pctS = v => (v == null ? "—" : `${Math.round(v * 100)}%`);
console.log("\n2. HOW FAST THE BOOK FOLLOWS A BRTI MOVE (final two minutes, every book change)");
console.log("   Event: the first BRTI tick 1s after which the index has moved at least N bp. Moves are measured from 1s");
console.log("   before the event, signed toward the index. \"share\" is the part of the +5s move already done; \"1c\" is how");
console.log("   often the book had moved at least 1c. \"pay\" is the price of the side the move favours (YES ask / NO ask).");
for (const [clock, label] of [["receive", "BOX RECEIVE CLOCK (what a bot here sees)"], ["source", "SOURCES' OWN CLOCKS"]]) {
  console.log(`\n   ${label}`);
  for (const thr of THRESHOLDS_BP) for (const subset of ["near", "all"]) {
    const rs = results[clock][thr][subset];
    const sm = summarise(rs, HORIZONS, "mid"), sp = summarise(rs, HORIZONS, "pay");
    console.log(`   ${thr}bp in 1s, ${subset === "near" ? "book 15-85c" : "any book"}: ${sm.n} events`);
    if (!sm.n) continue;
    console.log(`     horizon   ${HORIZONS.map(h => `${h >= 0 ? "+" : ""}${h}ms`.padStart(9)).join("")}`);
    console.log(`     mid       ${sm.rows.map(r => sign(r.mean).padStart(9)).join("")}`);
    console.log(`     share     ${sm.rows.map(r => pctS(r.share).padStart(9)).join("")}`);
    console.log(`     1c        ${sm.rows.map(r => pctS(r.moved1c).padStart(9)).join("")}`);
    console.log(`     pay       ${sp.rows.map(r => sign(r.mean).padStart(9)).join("")}`);
  }
}
console.log(`
READING THIS
- If "share" is already near 100% at +0ms, the book reprices as fast as the index reaches us: no lag to trade.
- If a large part arrives between +0 and +1000ms, that stretch is the window a bot would have, before costs:
  "pay" at +0 vs +5000ms is roughly what buying at the event saved, per contract, on average.
- Only the final two minutes are replayed (the record holds every change there); earlier in the window the book
  is recorded once a second, too coarse for this. Windows with a socket event or sequence gap are left out.`);
