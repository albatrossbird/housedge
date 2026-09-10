// How wrong is a FREE Coinbase feed as a stand-in for what Kalshi
// actually settled its 15-minute crypto markets on?
//
// KXBTC15M settles on "the simple average of the sixty seconds of CF
// Benchmarks' BRTI before <close>" against the same average fifteen
// minutes earlier. BRTI is a multi-exchange index, not Coinbase, and CF
// licenses it by contact with no public price and up to a 15-minute
// delay on their API — which is useless for a 15-minute market anyway.
//
// So the question is not "can we read BRTI" but "how wrong is the free
// proxy", and that is measurable against thousands of settled markets
// we already hold. THIS HALF IS BACKFILLABLE: Coinbase serves minute
// candles years back, and m15_markets carries `result` to 2026-06-30.
// It is the price PATH that cannot be recovered, not the underlying.
//
// Reads Supabase (anon) and Coinbase (no key). Writes nothing.
//
// Usage: node scripts/crypto-basis.mjs [--days=30] [SERIES ...]

import { indexCandles, refPrice, predict, marginBps, agreementByMargin } from "../lib/cryptoBasis.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (n, d) => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`));
  return h ? Number(h.split("=")[1]) : d;
};
const DAYS = arg("days", 30);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

// Kalshi series -> the Coinbase product that stands in for its index.
const PRODUCT = { KXBTC15M: "BTC-USD", KXETH15M: "ETH-USD", KXSOL15M: "SOL-USD", KXXRP15M: "XRP-USD" };
const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M", "KXETH15M");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Keyset, and a page cap reached is a TRUNCATION rather than a smaller
// answer, so it throws.
async function readAll(table, select, extra, keyCol = "id") {
  const out = [];
  let last = null;
  for (let p = 0; p < 4000; p++) {
    const after = last == null ? "" : `&${keyCol}=gt.${encodeURIComponent(last)}`;
    const rows = await rest(`${table}?select=${select}&${extra}${after}&order=${keyCol}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows[rows.length - 1][keyCol];
  }
  throw new Error(`readAll hit its page cap at ${out.length} rows — TRUNCATED`);
}

// Coinbase caps a candle request at 300 buckets and rate-limits public
// requests, so this walks the period in 300-minute slices with a pause.
// A failed slice is REPORTED, never silently skipped: a missing slice
// would drop markets from the sample and quietly shrink the denominator.
async function candles(product, fromSecs, toSecs, errors) {
  const all = [];
  for (let s = fromSecs; s < toSecs; s += 300 * 60) {
    const e = Math.min(s + 300 * 60, toSecs);
    const u = `https://api.exchange.coinbase.com/products/${product}/candles` +
              `?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const r = await fetch(u, { headers: { "User-Agent": "marketslap/1.0" } });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error(`coinbase ${r.status}`);
        all.push(...await r.json());
        ok = true;
      } catch (err) { if (attempt === 3) errors.push(`${new Date(s * 1000).toISOString()}: ${err.message}`); }
      await sleep(250);
    }
  }
  return all;
}

for (const s of series) {
  const product = PRODUCT[s];
  console.log(`\n${"=".repeat(72)}\n${s}  vs Coinbase ${product || "(unmapped)"}\n${"=".repeat(72)}`);
  if (!product) { console.log("::warning::no Coinbase product mapped — skipped"); continue; }

  const mk = await readAll("m15_markets", "ticker,close_time,result,strike",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "ticker");
  console.log(`settled markets, last ${DAYS}d   ${mk.length}`);
  if (!mk.length) { console.log("  nothing settled to compare against"); continue; }

  const times = mk.map(m => Math.floor(Date.parse(m.close_time) / 1000)).filter(Number.isFinite);
  const lo = Math.min(...times) - 20 * 60, hi = Math.max(...times) + 5 * 60;
  const errors = [];
  const rows = await candles(product, lo, hi, errors);
  const ix = indexCandles(rows);
  console.log(`coinbase minute candles     ${ix.size}`);
  if (errors.length) {
    console.log(`::error::${errors.length} candle slices failed — the sample is INCOMPLETE, not smaller`);
    for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
  }

  // Both readings of "the sixty-second average", because we do not get
  // to assume which a one-minute candle approximates better.
  for (const mode of ["close", "typical", "hl2"]) {
    const cases = [];
    let noData = 0;
    for (const m of mk) {
      const c = Math.floor(Date.parse(m.close_time) / 1000);
      if (!Number.isFinite(c)) continue;
      const closeRef = refPrice(ix, c, mode);
      const openRef = refPrice(ix, c - 15 * 60, mode);
      if (closeRef == null || openRef == null) { noData++; continue; }
      cases.push({ predicted: predict(openRef, closeRef), actual: m.result,
                   bps: marginBps(openRef, closeRef), ticker: m.ticker });
    }
    const a = agreementByMargin(cases);
    if (!a.n) { console.log(`\n  ${mode}: no overlapping candles`); continue; }
    console.log(`\n  reading the 60s reference as the candle ${mode.toUpperCase()}`);
    console.log(`    agreement  ${a.agree}/${a.n} = ${(100 * a.rate).toFixed(2)}%` +
                (noData ? `   (${noData} markets had no candle)` : ""));
    console.log(`    |margin|      n   agree    rate`);
    let prev = 0;
    for (const b of a.bands) {
      const label = b.hi === Infinity ? `>= ${prev}bp` : `${prev}-${b.hi}bp`;
      console.log(`    ${label.padEnd(12)} ${String(b.n).padStart(4)}  ${String(b.agree).padStart(5)}   ` +
                  `${(100 * b.agree / b.n).toFixed(1)}%`);
      prev = b.hi;
    }
  }

  console.log(`\n  A proxy for a multi-exchange index can only disagree NEAR A TIE.`);
  console.log(`  If the misses sit in the tightest band it is usable with a known`);
  console.log(`  blind spot; if they are spread across real moves it is not.`);
}
