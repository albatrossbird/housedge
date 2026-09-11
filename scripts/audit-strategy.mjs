// Score a published trading strategy against what actually settled.
//
// A strategy arrives as JSON in strategies/, so auditing a new claim is
// a data file rather than a rewrite. The arithmetic and the verdict
// live in lib/strategyAudit.js and are tested.
//
// Reads Supabase (anon) and Kalshi (no key). Writes nothing.
//
// Usage: node scripts/audit-strategy.mjs strategies/late-favourite-btc-15m.json [--days=21]

import { readFileSync } from "node:fs";
import { parseSpec, audit } from "../lib/strategyAudit.js";
import { pickOnePerTicker, feeOf } from "../lib/calibrate.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const files = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!files.length) { console.error("::error::pass a strategy JSON file"); process.exit(2); }
const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? Number(h.split("=")[1]) : d; };
const DAYS = arg("days", 21);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

async function rest(p) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${p.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function readAll(table, select, extra, keyCol = "id") {
  const out = []; let last = null;
  for (let i = 0; i < 4000; i++) {
    const after = last == null ? "" : `&${keyCol}=gt.${encodeURIComponent(last)}`;
    const rows = await rest(`${table}?select=${select}&${extra}${after}&order=${keyCol}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows[rows.length - 1][keyCol];
  }
  throw new Error("readAll hit its page cap — TRUNCATED");
}
// Fee parameters come from the API, never hardcoded.
async function feeMultiplier(s) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${s}`, { headers: { "User-Agent": "marketslap/1.0" } });
    if (!r.ok) return null;
    const m = Number((await r.json())?.series?.fee_multiplier);
    return Number.isFinite(m) ? m : null;
  } catch { return null; }
}
const pc = (x, d = 1) => (100 * x).toFixed(d);

for (const file of files) {
  let spec;
  try { spec = parseSpec(JSON.parse(readFileSync(file, "utf8"))); }
  catch (e) { console.error(`::error::${file}: ${e.message}`); process.exitCode = 1; continue; }

  console.log(`\n${"=".repeat(74)}`);
  console.log(`AUDIT: ${spec.name}`);
  if (spec.source) console.log(`claim: ${spec.source}`);
  console.log("=".repeat(74));
  const e = spec.entry;
  console.log(`filters: price ${e.price?.min ?? 0}-${e.price?.max ?? 1}` +
              `, spread <= ${e.spread?.max ?? "any"}` +
              `, T-${e.secsToClose?.max ?? "any"}s, side ${e.side}, hold to settlement`);
  if (spec.notes) console.log(`\nnote: ${spec.notes}\n`);

  for (const s of spec.series) {
    const mult = await feeMultiplier(s);
    if (mult == null) { console.log(`::warning::${s}: no fee_multiplier from Kalshi — skipped rather than assumed`); continue; }

    const mk = await readAll("m15_markets", "ticker,close_time,result",
      `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "ticker");
    if (!mk.length) { console.log(`\n${s}: nothing settled in ${DAYS}d`); continue; }
    const resultOf = new Map(mk.map(m => [m.ticker, m.result]));
    const dayOf = new Map(mk.map(m => [m.ticker, String(m.close_time).slice(0, 10)]));

    const maxSecs = e.secsToClose?.max ?? 90;
    const tickers = [...resultOf.keys()];
    const q = [];
    for (let i = 0; i < tickers.length; i += 200) {
      const ids = tickers.slice(i, i + 200).map(t => `"${t}"`).join(",");
      q.push(...await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
        `ticker=in.(${encodeURIComponent(ids)})&secs_to_close=lte.${maxSecs}&secs_to_close=gte.0&`));
    }
    // One observation per market, nearest the entry moment — the same
    // rule the calibration uses, and for the same reason: counting rows
    // would weight the sample toward volatile markets.
    const obs = pickOnePerTicker(q, maxSecs, { known: new Set(resultOf.keys()) });

    const r = audit(obs, resultOf, spec, mult, t => dayOf.get(t));
    console.log(`\n--- ${s} (fee multiplier ${mult}) ---`);
    console.log(`  settled markets ${mk.length}   usable quotes ${obs.length}   entries ${r.n}`);
    if (!r.n) { console.log(`  VERDICT: ${r.verdict.call} — ${r.verdict.why}`); continue; }

    console.log(`  yes/no             ${r.sides.yes} / ${r.sides.no}`);
    console.log(`  avg entry price    ${pc(r.avgEntry)}%`);
    console.log(`  win rate           ${pc(r.winRate)}%      <- the headline number`);
    console.log(`  breakeven needed   ${pc(r.breakeven)}%      <- price + fee`);
    console.log(`  edge over price    ${r.edgeOverPrice >= 0 ? "+" : ""}${pc(r.edgeOverPrice, 2)}pt   (SE ${pc(r.se, 2)}pt)`);
    console.log(`  gross EV/contract  ${r.grossPer >= 0 ? "+" : ""}${pc(r.grossPer, 2)}c`);
    console.log(`  NET  EV/contract   ${r.netPer >= 0 ? "+" : ""}${pc(r.netPer, 2)}c`);
    console.log(`  distinct days      ${r.days}`);
    console.log(`\n  entry band      n   win%   net/ct`);
    for (const b of r.bands) {
      console.log(`  ${b.lo.toFixed(2)}-${(b.lo + 0.05).toFixed(2)} ${String(b.n).padStart(5)}  ${pc(b.wins / b.n)}%  ` +
                  `${b.net / b.n >= 0 ? "+" : ""}${pc(b.net / b.n, 2)}c`);
    }
    console.log(`\n  VERDICT: ${r.verdict.call}`);
    console.log(`  ${r.verdict.why}`);
  }

  console.log(`\n  NOT MODELLED: fill. Kalshi publishes no size on the 15m family`);
  console.log(`  (bid_size/ask_size are null), so every figure assumes the whole`);
  console.log(`  order filled at the touch. Treat it as an UPPER BOUND.`);
}
