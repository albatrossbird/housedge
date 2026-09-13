// Before trusting Kairos candles to widen the calibration sample,
// measure how far they sit from what we actually recorded.
//
// THE QUESTION. Kairos serves 1-minute Kalshi candles with 30-day
// retention — six times the price path our own recorder has gathered.
// Using it would lift the auditor's INSUFFICIENT verdict today rather
// than in ten days. But a candle is TRADED prices and our calibration
// needs the ASK, and those two are closest exactly where nothing is at
// stake and furthest exactly where the money is.
//
// So this compares them ON THE OVERLAP, where we hold both, rather
// than assuming the substitution is safe. Same method as Coinbase
// against BRTI and NWS against The Weather Company: score the cheap
// source against the one we trust, and report the gap BY MARGIN
// instead of as one average.
//
// Writes NOTHING. Kairos data never enters m15_quotes — that table
// records the book, and mixing traded prices into it would destroy the
// distinction that makes it worth having.
//
// Usage: node scripts/kairos-probe.mjs [--secs=90] [--days=7] [SERIES]

import { candleBatch, centsToPrice, candleCovering, CANDLE_BATCH } from "../lib/kairos.js";
import { pickOnePerTicker } from "../lib/calibrate.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? Number(h.split("=")[1]) : d; };
const TARGET = arg("secs", 90), TOL = arg("tol", 45), DAYS = arg("days", 7);
const series = process.argv.slice(2).filter(a => !a.startsWith("-"))[0] || "KXBTC15M";
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

async function rest(p) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${p.slice(0, 60)} -> ${r.status}`);
  return r.json();
}
async function readAll(table, select, extra, keyCol = "id") {
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

console.log(`${series}: comparing Kairos 1m candles against our recorded book at T-${TARGET}s\n`);

const mk = await readAll("m15_markets", "ticker,close_time,result",
  `series=eq.${encodeURIComponent(series)}&result=not.is.null&close_time=gte.${SINCE}&`, "ticker");
if (!mk.length) { console.log("nothing settled in that window"); process.exit(0); }
const closeOf = new Map(mk.map(m => [m.ticker, Math.floor(Date.parse(m.close_time) / 1000)]));

const tickers = [...closeOf.keys()];
const q = [];
for (let i = 0; i < tickers.length; i += 200) {
  const ids = tickers.slice(i, i + 200).map(t => `"${t}"`).join(",");
  q.push(...await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
    `ticker=in.(${encodeURIComponent(ids)})&secs_to_close=gte.${TARGET - TOL}&secs_to_close=lte.${TARGET + TOL}&`));
}
const ours = pickOnePerTicker(q, TARGET, { known: new Set(closeOf.keys()) });
console.log(`settled markets      ${mk.length}`);
console.log(`with a recorded book ${ours.length}`);
if (!ours.length) { console.log("no overlap to compare"); process.exit(0); }

// Fetch the whole life of each market: 200 series of 15 bars is 3,000
// bars, one light unit.
const need = ours.map(o => ({ ticker: o.ticker, start: (closeOf.get(o.ticker) - 16 * 60) * 1000, end: (closeOf.get(o.ticker) + 60) * 1000 }));
const byTicker = new Map();
const failures = [];
for (let i = 0; i < need.length; i += CANDLE_BATCH) {
  const { series: got, failures: f, remaining } = await candleBatch(need.slice(i, i + CANDLE_BATCH));
  for (const s of got) byTicker.set(s.ticker, s.candles);
  failures.push(...f);
  if (i === 0) console.log(`rate-limit remaining ${remaining ?? "?"} after the first batch`);
  await new Promise(r => setTimeout(r, 600));
}
console.log(`series returned      ${byTicker.size}`);
// A per-index failure is a HOLE, not a smaller sample.
if (failures.length) {
  console.log(`::warning::${failures.length} series failed — the sample is INCOMPLETE`);
  for (const f of failures.slice(0, 5)) console.log(`  ${f.ticker}: ${f.error}`);
}

const diffs = [];
let noCandle = 0;
for (const o of ours) {
  // The instant this quote was actually recorded at, not the nominal
  // target: pickOnePerTicker takes the NEAREST quote in a window, so
  // its own secs_to_close is the truth.
  const secs = Number(o.secs_to_close);
  if (!Number.isFinite(secs)) { noCandle++; continue; }
  const c = candleCovering(byTicker.get(o.ticker), closeOf.get(o.ticker) - secs);
  if (!c) { noCandle++; continue; }
  const close = centsToPrice(c.close);
  const ask = Number(o.yes_ask), bid = Number(o.yes_bid);
  if (close == null || !Number.isFinite(ask) || !Number.isFinite(bid)) continue;
  diffs.push({ ticker: o.ticker, close, ask, bid, dAsk: close - ask, inside: close >= bid && close <= ask });
}

if (!diffs.length) { console.log("\nno comparable minutes — candles and quotes did not overlap"); process.exit(0); }

const sorted = [...diffs].map(d => d.dAsk).sort((a, b) => a - b);
const pctl = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const inside = diffs.filter(d => d.inside).length;
const pc = (x, n = 2) => `${(100 * x).toFixed(n)}c`;

console.log(`\ncomparable minutes   ${diffs.length}` + (noCandle ? `   (${noCandle} had no candle)` : ""));
console.log(`\ncandle CLOSE minus our recorded ASK`);
console.log(`  median      ${pc(pctl(0.5))}`);
console.log(`  p10 / p90   ${pc(pctl(0.1))} / ${pc(pctl(0.9))}`);
console.log(`  min / max   ${pc(sorted[0])} / ${pc(sorted[sorted.length - 1])}`);
console.log(`\n  inside our bid-ask  ${inside}/${diffs.length} = ${(100 * inside / diffs.length).toFixed(1)}%`);
console.log(`  <- the honest test. A traded price inside the book we recorded is`);
console.log(`     consistent with it; one outside means the two sources disagree`);
console.log(`     about what the market was, not merely about trade vs quote.`);

const band = [0.005, 0.01, 0.02, 0.05, Infinity];
let prev = 0;
console.log(`\n  |difference|      n     share`);
for (const hi of band) {
  const n = diffs.filter(d => Math.abs(d.dAsk) >= prev && Math.abs(d.dAsk) < hi).length;
  if (n) console.log(`  ${(prev * 100).toFixed(1)}-${hi === Infinity ? "+" : (hi * 100).toFixed(1)}c`.padEnd(18) +
                     `${String(n).padStart(4)}   ${(100 * n / diffs.length).toFixed(1)}%`);
  prev = hi;
}
console.log(`\n  A candle is the last TRADE and our ask is what a buyer pays, so a`);
console.log(`  small positive gap is EXPECTED, not error. What would disqualify`);
console.log(`  the substitution is a wide or two-sided spread of differences.`);
