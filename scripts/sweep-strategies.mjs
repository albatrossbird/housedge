// Is there anything in this data OTHER than the strategy we were handed?
//
// The audited strategy is one point in a space. This walks a grid of
// them across two very different underlyings — BTC, which trades around
// the clock and is the most liquid of the family, and gold, which is
// closed out of hours and far thinner — and asks whether the best
// result in that grid is distinguishable from what trying that many
// things produces on its own.
//
// THE GRID IS HYPOTHESES, NOT A CROSS-PRODUCT FOR ITS OWN SAKE. Each
// axis is here because it encodes a real question:
//
//   price band   longshot bias is the best-documented anomaly in
//                prediction markets: cheap contracts are said to be
//                systematically overpriced and favourites underpriced.
//                Six bands test that across the range rather than
//                asserting it.
//   side         buying NO at 0.90 and buying YES at 0.10 are near
//                mirrors but not the same trade — different book,
//                different fee on a different price — so both run.
//   seconds      the audited claim enters in the last 90 seconds. If an
//                edge exists only there it is a microstructure effect;
//                if it holds at ten minutes it is a pricing one. That
//                distinction decides whether it is tradeable by a
//                person or only by a machine.
//
// Reads Supabase (anon) and Kalshi (no key). Writes nothing.
//
// Usage: node scripts/sweep-strategies.mjs [--days=21] [--draws=400]

import { pickOnePerTicker } from "../lib/calibrate.js";
import { collectEntries, score, realWin, nullDistribution, quantile, pValue }
  from "../lib/strategySweep.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? Number(h.split("=")[1]) : d; };
const DAYS = arg("days", 21);
const DRAWS = arg("draws", 400);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

const SERIES = ["KXBTC15M", "KXGOLD15M"];
const BANDS = [[0.05, 0.20], [0.20, 0.40], [0.40, 0.60], [0.60, 0.80], [0.80, 0.90], [0.90, 0.98]];
const SIDES = ["yes", "no"];
const WINDOWS = [60, 180, 600];

function grid() {
  const out = [];
  for (const [lo, hi] of BANDS) for (const side of SIDES) for (const secs of WINDOWS) {
    out.push({
      label: `${side.toUpperCase()} ${lo.toFixed(2)}-${hi.toFixed(2)} @T-${secs}s`,
      entry: { side, price: { min: lo, max: hi }, secsToClose: { max: secs } },
      exit: "settlement",
    });
  }
  return out;
}

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
const pc = (x, d = 2) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(d)}`;

const specs = grid();
console.log(`STRATEGY SWEEP  ${specs.length} variants x ${SERIES.length} series = ${specs.length * SERIES.length} tests`);
console.log(`window ${DAYS}d, null ${DRAWS} simulated worlds per series\n`);

const MAX_SECS = Math.max(...WINDOWS);
let anyProven = false;

for (const s of SERIES) {
  const mult = await feeMultiplier(s);
  if (mult == null) { console.log(`::warning::${s}: no fee_multiplier from Kalshi — skipped rather than assumed`); continue; }

  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "ticker");
  if (!mk.length) { console.log(`\n${s}: nothing settled in ${DAYS}d`); continue; }
  const resultOf = new Map(mk.map(m => [m.ticker, m.result]));
  const dayOf = new Map(mk.map(m => [m.ticker, String(m.close_time).slice(0, 10)]));

  const tickers = [...resultOf.keys()];
  const q = [];
  for (let i = 0; i < tickers.length; i += 200) {
    const ids = tickers.slice(i, i + 200).map(t => `"${t}"`).join(",");
    q.push(...await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
      `ticker=in.(${encodeURIComponent(ids)})&secs_to_close=lte.${MAX_SECS}&secs_to_close=gte.0&`));
  }

  // ONE OBSERVATION PER MARKET PER WINDOW. m15_quotes is
  // write-on-change, so counting rows weights the sample toward
  // volatile markets — exactly the ones likeliest to settle against
  // their quote. Each time window gets its own pick, because the
  // nearest quote to T-60 is not the nearest to T-600.
  const obsByWindow = new Map(
    WINDOWS.map(w => [w, pickOnePerTicker(q, w, { known: new Set(resultOf.keys()) })]));
  const obs = [];
  for (const [w, rows] of obsByWindow) for (const r of rows) obs.push({ ...r, __w: w });

  // Each spec only sees observations picked for its own window.
  const per = specs.map((sp, i) =>
    collectEntries(obs.filter(o => o.__w === sp.entry.secsToClose.max), [sp])[0]);

  const rows = specs.map((sp, i) => {
    const r = per[i].length ? score(per[i], mult, realWin(resultOf), t => dayOf.get(t)) : null;
    return { label: sp.label, r };
  }).filter(x => x.r && x.r.n > 0);

  console.log(`${"=".repeat(74)}`);
  console.log(`${s}  (fee multiplier ${mult})  ${mk.length} settled markets, ${q.length} quote rows`);
  console.log(`${"=".repeat(74)}`);
  if (!rows.length) { console.log("  no variant took a single entry\n"); continue; }

  rows.sort((a, b) => b.r.netPer - a.r.netPer);
  console.log(`  ${"variant".padEnd(26)} ${"n".padStart(5)} ${"days".padStart(5)} ${"win%".padStart(7)} ${"edge".padStart(8)} ${"net/ct".padStart(8)}`);
  for (const { label, r } of rows) {
    console.log(`  ${label.padEnd(26)} ${String(r.n).padStart(5)} ${String(r.days).padStart(5)} ` +
                `${(100 * r.winRate).toFixed(1).padStart(6)}% ${pc(r.edgeOverPrice).padStart(8)} ${pc(r.netPer).padStart(8)}`);
  }

  // THE CORRECTION. The best of N is not the same object as one test.
  const nd = nullDistribution(per, mult, { draws: DRAWS });
  const best = rows[0];
  const pNet = pValue(nd.bestNet, best.r.netPer);
  const pEdge = pValue(nd.bestEdge, Math.abs(best.r.edgeOverPrice));

  console.log(`\n  BEST: ${best.label}`);
  console.log(`    net ${pc(best.r.netPer)}c/contract on ${best.r.n} entries over ${best.r.days} days`);
  console.log(`\n  AGAINST A CALIBRATED-MARKET NULL (${nd.draws} simulated worlds, same entries)`);
  console.log(`    best net/ct reached by NOISE  median ${pc(quantile(nd.bestNet, 0.5))}c` +
              `   95th ${pc(quantile(nd.bestNet, 0.95))}c`);
  console.log(`    best |edge| reached by NOISE  median ${pc(quantile(nd.bestEdge, 0.5))}pt` +
              `   95th ${pc(quantile(nd.bestEdge, 0.95))}pt`);
  console.log(`    p(noise >= our best net)   ${pNet.toFixed(3)}`);
  console.log(`    p(noise >= our best |edge|) ${pEdge.toFixed(3)}`);

  if (pNet <= 0.05) {
    anyProven = true;
    console.log(`\n    SURVIVES the multiplicity correction. Worth a real look.`);
  } else {
    console.log(`\n    DOES NOT SURVIVE. A sweep this wide reaches this result on`);
    console.log(`    noise roughly ${(100 * pNet).toFixed(0)}% of the time, so the winner is`);
    console.log(`    not evidence of anything. This is the expected answer at this`);
    console.log(`    sample size and is NOT a reason to discard the direction.`);
  }
  console.log();
}

console.log("=".repeat(74));
console.log("WHAT THIS CAN AND CANNOT SAY");
console.log("  Fill is not modelled: Kalshi publishes no size on the 15m family,");
console.log("  so every figure assumes the whole order filled at the touch. Every");
console.log("  net figure above is an UPPER BOUND.");
console.log("  The null assumes the market is calibrated, which is the hypothesis");
console.log("  a strategy must beat. It does NOT model adverse selection: in a");
console.log("  real book the fills you get are the ones someone wanted to give.");
if (!anyProven) {
  console.log("\n  Nothing in this grid survived its own multiplicity. That is a");
  console.log("  result about the SAMPLE, not about the strategies — the same");
  console.log("  sweep on more days may separate them, and re-running it is how");
  console.log("  you find out rather than assuming either way.");
}
