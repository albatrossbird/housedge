// Market-making study, Part A (docs/research/mm-plan.md): one sweep of
// every market in Kalshi's Liquidity Incentive Program, asking what share
// of its pool a small resting quote would score in the book as it stands.
//
//   node scripts/lip-sweep.mjs [--capital=200] [--pace=220] [--out=.lip-cache]
//
// Public endpoints only (/incentive_programs, /markets/<t>/orderbook): no
// key, no order, no Supabase. About 6,000 requests, ~25 minutes at Kalshi's
// ~5 requests a second. Each sweep is saved under --out (gitignored) so
// three sweeps at different hours can be compared.
//
// The plan's stop: the median market pays the quote under $0.50 a day AND
// fewer than 50 markets pay it $2 a day or more.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quoteReward, poolPerDay } from "../lib/lip.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const CAPITAL = Number(opt("capital", 200)), PACE = Number(opt("pace", 220)), OUT = opt("out", ".lip-cache");
const LIMIT = Number(opt("limit", 0));   // for a quick check: only the first N markets
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, refused = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 6; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    let r;
    try { r = await fetch(B + path); } catch { await sleep(1500 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { refused++; const ra = Number(r.headers.get("retry-after")); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path.slice(0, 90)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 90)}: still refused after 6 tries`);
}

const t0 = Date.now();
const programs = [];
let cursor = "";
do {
  const d = await get(`/incentive_programs?status=active&type=liquidity&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  programs.push(...(d?.incentive_programs || []).filter(p => p.incentive_type === "liquidity"));
  cursor = d?.next_cursor || "";
} while (cursor);
// A market can sit in more than one program; its pools add.
const byMarket = new Map();
for (const p of programs) {
  const m = byMarket.get(p.market_ticker) || { ticker: p.market_ticker, series: p.series_ticker, pool: 0, target: Number(p.target_size_fp), discount: Number(p.discount_factor_bps) / 1e4, programs: 0 };
  m.pool += poolPerDay(p); m.programs++; m.target = Math.max(m.target, Number(p.target_size_fp));
  byMarket.set(p.market_ticker, m);
}
let markets = [...byMarket.values()];
if (LIMIT) markets = markets.slice(0, LIMIT);
console.log(`LIQUIDITY INCENTIVE SWEEP ${new Date(t0).toISOString()}: ${programs.length} active programs, ${byMarket.size} markets, ${new Set(programs.map(p => p.series_ticker)).size} series; quote $${CAPITAL} a market`);

const rows = [], why = {};
let missing = 0;
for (const m of markets) {
  const d = await get(`/markets/${encodeURIComponent(m.ticker)}/orderbook`);
  const ob = d?.orderbook_fp || d?.orderbook;
  if (!ob) { missing++; continue; }
  const q = quoteReward({ yes: ob.yes_dollars || [], no: ob.no_dollars || [], target: m.target, discount: m.discount, poolPerDay: m.pool, capital: CAPITAL });
  rows.push({ ...m, ...q });
  if (q.why) why[q.why] = (why[q.why] || 0) + 1;
  if (rows.length % 1000 === 0) console.error(`  ${rows.length}/${markets.length} books, ${requests} requests, ${Math.round((Date.now() - t0) / 1000)}s`);
}

const $ = v => `$${v.toFixed(2)}`;
const med = a => a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : 0;
const totalPool = rows.reduce((s, r) => s + r.pool, 0);
console.log(`\n${rows.length} books read (${missing} missing), ${requests} requests (${refused} refused and retried), ${Math.round((Date.now() - t0) / 60000)} minutes`);
console.log(`pools: ${$(totalPool)} a day in all; a median market ${$(med(rows.map(r => r.pool)))} a day; target size median ${med(rows.map(r => r.target))}; discount factor median ${med(rows.map(r => r.discount))}`);
for (const k of ["lenient", "strict"]) {
  const pay = rows.map(r => r.perDay[k]), counting = rows.filter(r => r.counts[k]);
  const live = rows.filter(r => r.perDay[k] > 0).sort((a, b) => b.perDay[k] - a.perDay[k]);
  console.log(`\n${k === "lenient" ? "TARGET SIZE READ AS PLAIN RESTING SIZE (lenient)" : "TARGET SIZE READ AS SCORE NEAR THE PRICE (strict)"}`);
  console.log(`  snapshot would count with our quote added: ${counting.length} of ${rows.length} markets, holding ${$(counting.reduce((s, r) => s + r.pool, 0))} a day of pools`);
  console.log(`  our $${CAPITAL} would be paid: median market ${$(med(pay))} a day (median of the paying ones ${$(med(live.map(r => r.perDay[k])))}); $2+ a day on ${pay.filter(v => v >= 2).length} markets, $0.50+ on ${pay.filter(v => v >= 0.5).length}`);
  console.log(`  median share of a side where it counts: ${(100 * med(counting.map(r => (r.shareYes + r.shareNo) / 2))).toFixed(1)}%`);
  const top = live.slice(0, 25), topCost = top.reduce((s, r) => s + r.cost, 0), topPay = top.reduce((s, r) => s + r.perDay[k], 0);
  console.log(`  the best 25: ${$(topPay)} a day on ${$(topCost)} resting (${topCost ? (100 * topPay / topCost).toFixed(2) : "0"}% a day BEFORE any loss on fills)`);
  if (k === "lenient") {
    console.log("  market                                   pool/day  target  disc   S    cost   yes share  no share   $/day");
    for (const r of top.slice(0, 15)) console.log(`  ${r.ticker.padEnd(40)} ${$(r.pool).padStart(8)}  ${String(r.target).padStart(6)}  ${r.discount.toFixed(2)}  ${String(r.S).padStart(4)}  ${$(r.cost).padStart(7)}  ${(100 * r.shareYes).toFixed(1).padStart(8)}%  ${(100 * r.shareNo).toFixed(1).padStart(7)}%  ${$(r.perDay[k]).padStart(6)}`);
    const bySeries = new Map();
    for (const r of live) { const s = bySeries.get(r.series) || { n: 0, pay: 0 }; s.n++; s.pay += r.perDay[k]; bySeries.set(r.series, s); }
    console.log(`  by series (top 10 by what our quotes would be paid): ${[...bySeries].sort((a, b) => b[1].pay - a[1].pay).slice(0, 10).map(([s, v]) => `${s} ${$(v.pay)}/${v.n}`).join("; ")}`);
  }
}
console.log(`\nwhy a quote would earn nothing: ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`).join("; ") || "—"}`);
const L = rows.map(r => r.perDay.lenient);
const stop = med(L) < 0.5 && L.filter(v => v >= 2).length < 50;
console.log(`\nPART A (lenient reading): ${stop ? "STOP — the median market pays under $0.50 and fewer than 50 pay $2+" : "CONTINUE to the next sweep"}`);
console.log("One book at one moment; a share is before anyone reacts to our quote, and says nothing yet about what the fills cost.");

mkdirSync(OUT, { recursive: true });
const file = join(OUT, `sweep-${new Date(t0).toISOString().replace(/[:.]/g, "")}.json`);
writeFileSync(file, JSON.stringify({ at: t0, capital: CAPITAL, rows }));
console.log(`saved ${file}`);
