// Can we trade Kalshi's weather markets on a FREE NWS observation, or
// do we need the paid source it actually settles on?
//
// Every daily temperature market resolves "according to The Weather
// Company". We record NWS. So a gap between Kalshi's price and our
// forecast has two causes we cannot currently separate: Kalshi is
// mispriced, or TWC and NWS differ.
//
// This measures the second one WITHOUT a TWC key, by scoring an
// NWS-derived daily high against Kalshi's own settled result — the same
// method used for Coinbase against BRTI and Yahoo against Pyth.
//
// Both sources ultimately read the same ASOS instrument at these
// airports, so the basis is about ROUNDING, the day boundary and QC
// rather than about measurement. Rounding is reported both ways because
// Kalshi's thresholds are whole degrees and the Celsius conversion
// lands between them.
//
// Reads Supabase (anon) and NWS (no key). Writes nothing.
//
// Usage: node scripts/wx-basis.mjs [--days=7]

import { dailyExtremes, resolves, marginF, roundings, STATION_TZ } from "../lib/wxBasis.js";
import { nwsGet } from "../lib/weather.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? Number(h.split("=")[1]) : d; };
// NWS serves about a week of observations, so asking for more is asking
// for nothing.
const DAYS = Math.min(arg("days", 7), 7);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

async function rest(p) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${p.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function readAll(table, select, extra, keyCol = "ticker") {
  const out = []; let last = null;
  for (let i = 0; i < 2000; i++) {
    const after = last == null ? "" : `&${keyCol}=gt.${encodeURIComponent(last)}`;
    const rows = await rest(`${table}?select=${select}&${extra}${after}&order=${keyCol}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows[rows.length - 1][keyCol];
  }
  throw new Error("readAll hit its page cap — TRUNCATED");
}

const mk = await readAll("wx_markets",
  "ticker,station,cli,target_date,result,strike_type,floor_strike,cap_strike,close_time",
  `result=not.is.null&close_time=gte.${SINCE}&`);
console.log(`settled weather markets, last ${DAYS}d   ${mk.length}`);
if (!mk.length) {
  console.log("\n  Nothing has settled yet in that window. The recorder started");
  console.log("  2026-09-10, and a daily market settles the morning after its");
  console.log("  target date — so this becomes answerable within a day or two,");
  console.log("  and gets stronger every day after.");
  process.exit(0);
}

const stations = [...new Set(mk.map(m => m.station).filter(Boolean))];
console.log(`stations                          ${stations.length}`);

const start = SINCE, end = new Date().toISOString();
const extremes = new Map();
let qcRejected = 0, noTemp = 0;
const failed = [];
for (const st of stations) {
  const tz = STATION_TZ[st];
  if (!tz) { failed.push(`${st}: no timezone mapped`); continue; }
  try {
    const j = await nwsGet(`/stations/${st}/observations?start=${start}&end=${end}&limit=500`);
    const { byDate, rejected, noTemp: nt } = dailyExtremes(j.features || [], tz);
    extremes.set(st, byDate); qcRejected += rejected; noTemp += nt;
  } catch (err) { failed.push(`${st}: ${err.message}`.slice(0, 110)); }
  await new Promise(r => setTimeout(r, 250));
}
console.log(`QC-rejected readings              ${qcRejected}`);
console.log(`readings with no temperature      ${noTemp}`);
// A station that failed is a HOLE in the sample, not a smaller sample.
if (failed.length) {
  console.log(`::warning::${failed.length} stations unread — the sample is INCOMPLETE`);
  for (const f of failed.slice(0, 8)) console.log(`  ${f}`);
}

// Only the HIGH markets are scored here. A low-temperature market tests
// the daily minimum against the same threshold machinery, but mixing
// them into one agreement figure would hide a rounding convention that
// differs between the two.
for (const mode of ["round", "floor", "raw"]) {
  const cases = [];
  let noObs = 0, unreadable = 0;
  for (const m of mk) {
    const isHigh = /HIGH/i.test(m.ticker);
    const day = extremes.get(m.station)?.get(m.target_date);
    if (!day) { noObs++; continue; }
    const base = isHigh ? day.highF : day.lowF;
    const observed = roundings(base)[mode];
    const pred = resolves(observed, m);
    if (pred == null) { unreadable++; continue; }
    cases.push({ ok: (pred ? "yes" : "no") === m.result, margin: marginF(observed, m), ticker: m.ticker });
  }
  if (!cases.length) { console.log(`\n  ${mode}: nothing comparable`); continue; }
  const agree = cases.filter(c => c.ok).length;
  console.log(`\n  NWS daily extreme, rounded by ${mode.toUpperCase()}`);
  console.log(`    agreement with Kalshi's settlement  ${agree}/${cases.length} = ` +
              `${(100 * agree / cases.length).toFixed(1)}%` +
              (noObs ? `   (${noObs} had no observation)` : "") +
              (unreadable ? `   (${unreadable} unreadable strike)` : ""));
  // A proxy can only disagree NEAR the line.
  for (const [lo, hi] of [[0, 1], [1, 2], [2, 5], [5, Infinity]]) {
    const band = cases.filter(c => c.margin != null && Math.abs(c.margin) >= lo && Math.abs(c.margin) < hi);
    if (!band.length) continue;
    const a = band.filter(c => c.ok).length;
    console.log(`    |margin| ${lo}-${hi === Infinity ? "+" : hi}F` +
                `   n=${String(band.length).padStart(4)}  agree=${String(a).padStart(4)}  ` +
                `${(100 * a / band.length).toFixed(1)}%`);
  }
  const misses = cases.filter(c => !c.ok).slice(0, 8);
  if (misses.length) {
    console.log(`    first disagreements:`);
    for (const m of misses) console.log(`      ${m.ticker}  margin ${m.margin == null ? "?" : m.margin.toFixed(2)}F`);
  }
}

console.log(`\n  If the misses sit inside a degree, NWS is usable with a known`);
console.log(`  blind spot and no TWC licence is needed. If they are spread`);
console.log(`  across real margins, the basis is the risk and TWC is worth`);
console.log(`  paying for. That is the decision this measures.`);
