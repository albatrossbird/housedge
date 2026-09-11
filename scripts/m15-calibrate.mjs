// Is a 15-minute market quoted at price p, with T seconds left, right?
//
// THE QUESTION THIS ANSWERS. Every "buy the favourite late" strategy on
// this family reduces to one measurable claim: of the markets quoted at
// p with T seconds to run, what fraction actually resolve YES?
//
//   observed == p          the market is calibrated. There is no edge,
//                          and the fee makes the strategy a slow loss.
//   observed >  p + fee    there is a real edge at that price.
//
// A HIGH WIN RATE IS NOT AN EDGE. Buying at 0.92 and winning 93% of the
// time is roughly what a FAIR market pays you; the win rate is a fact
// about the entry price, not about skill. Only the gap over price, net
// of fees, is a finding — so this reports the gap, never the win rate
// on its own.
//
// The arithmetic lives in lib/calibrate.js and is tested by
// scripts/calibrate.test.mjs. This file does IO and printing only, so
// the sampling rule that decides the answer cannot drift untested.
//
// Reads only, anon key, writes nothing.
//
// Usage: node scripts/m15-calibrate.mjs [--secs=90] [--tol=45] [SERIES ...]

import { feeOf, pickOnePerTicker, bucketize, simulate } from "../lib/calibrate.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : dflt;
};
const TARGET    = arg("secs", 90);      // seconds to close at the entry moment
const TOL       = arg("tol", 45);       // how far from TARGET a quote may sit
const MAXSPREAD = arg("spread", 0.03);
const LO = arg("lo", 0.65), HI = arg("hi", 0.95);
// How far back to look for settled markets.
//
// NOT a tuning knob — a correctness one. The price path only exists
// from the day the recorder started, so a market that settled before
// then can NEVER contribute an observation however far back we read.
// The first version read every settled market since 2026-06-30 and was
// killed by Postgres with 57014: thousands of rows fetched to be
// joined against a quote table that has nothing to say about them.
const DAYS = arg("days", 21);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M");

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Keyset, like every pager here. m15_quotes grows ~50k rows a day and
// an OFFSET pager over it is the bug this repo has fixed four times.
// A page cap reached is a TRUNCATION, not a smaller answer, so it
// throws rather than returning what it has.
async function readAll(table, select, extra, keyCol = "id") {
  const out = [];
  let last = null;
  for (let page = 0; page < 4000; page++) {
    const after = last == null ? "" : `&${keyCol}=gt.${encodeURIComponent(last)}`;
    const rows = await rest(`${table}?select=${select}&${extra}${after}&order=${keyCol}.asc&limit=1000`);
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows[rows.length - 1][keyCol];
  }
  throw new Error(`readAll hit its page cap at ${out.length} rows — TRUNCATED`);
}

// Fee parameters come from the API, never hardcoded: Kalshi's
// multiplier is per series and a constant in code goes stale silently
// and produces confident wrong answers.
async function feeMultiplier(s) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${s}`,
                          { headers: { "User-Agent": "marketslap/1.0" } });
    if (!r.ok) throw new Error(`kalshi ${r.status}`);
    const m = Number((await r.json())?.series?.fee_multiplier);
    return isFinite(m) ? m : null;
  } catch { return null; }
}

const fmt = (x, d = 1) => (x * 100).toFixed(d);
const sign = x => (x >= 0 ? "+" : "");

for (const s of series) {
  console.log(`\n${"=".repeat(72)}\n${s}   entry at T-${TARGET}s (+/-${TOL}s)\n${"=".repeat(72)}`);

  const mult = await feeMultiplier(s);
  if (mult == null) {
    console.log("::warning::could not read fee_multiplier from Kalshi — skipped rather than assuming 1");
    continue;
  }
  console.log(`fee_multiplier ${mult}`);

  // Settled markets in the window the recorder actually covers. A live
  // market has no result to calibrate against; `result` is null on one,
  // never "", by the recorder's own rule.
  //
  // series + close_time is exactly what m15_markets_series_close_idx
  // serves, so this is an index scan over a few hundred rows rather
  // than the whole backfill.
  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null` +
    `&close_time=gte.${SINCE}&`, "ticker");
  const resultOf = new Map(mk.map(m => [m.ticker, m.result]));
  console.log(`settled markets, last ${DAYS}d    ${mk.length}`);
  if (!mk.length) { console.log("  nothing settled in that window to calibrate against"); continue; }

  // Quotes for those markets, inside the entry band.
  //
  // Asked BY TICKER rather than by a LIKE prefix: m15_quotes is indexed
  // on (ticker, observed_at) and a prefix match cannot be trusted to
  // use it, while this table is the big one and grows ~50k rows a day.
  // Chunked at 200 ids, per the .in() URL-length lesson — a few
  // thousand ids build a URL long enough to kill the request.
  const tickers = [...resultOf.keys()];
  const q = [];
  for (let i = 0; i < tickers.length; i += 200) {
    const ids = tickers.slice(i, i + 200).map(t => `"${t}"`).join(",");
    q.push(...await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
      `ticker=in.(${encodeURIComponent(ids)})` +
      `&secs_to_close=gte.${TARGET - TOL}&secs_to_close=lte.${TARGET + TOL}&`));
  }
  console.log(`quotes in the window         ${q.length}`);

  const obs = pickOnePerTicker(q, TARGET, { known: new Set(resultOf.keys()) });
  console.log(`markets with a usable quote  ${obs.length}   <-- one per market, see lib/calibrate.js`);
  if (!obs.length) {
    console.log("\n  No price path in this window yet. The recorder has been running");
    console.log("  since 2026-09-06 and only covers windows it was awake for —");
    console.log("  this half of the data cannot be backfilled. Settled markets");
    console.log("  older than that carry an outcome but only a LAST price, which");
    console.log("  cannot answer what a market was quoted at with 90s to run.");
    continue;
  }

  console.log(`\ncalibration — pay yes_ask, win if it settles YES`);
  console.log(`  ask band       n    avg ask   settled YES   gap      fee     net edge`);
  for (const b of bucketize(obs, resultOf)) {
    const f = feeOf(b.avgAsk, mult);
    const net = b.gap - f;
    // Under ~30 a bucket says nothing: the standard error on a rate is
    // wider than any edge worth trading.
    const flag = b.n < 30 ? "   (thin)" : net > 0 ? "   <-- edge" : "";
    console.log(`  ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  ${String(b.n).padStart(5)}   ` +
      `${fmt(b.avgAsk)}%     ${fmt(b.hit)}%      ${sign(b.gap)}${fmt(b.gap)}pt  ` +
      `${fmt(f, 2)}pt   ${sign(net)}${fmt(net)}pt${flag}`);
  }

  console.log(`\nthe strategy: buy either side in [${LO}, ${HI}], spread <= ${MAXSPREAD}`);
  const r = simulate(obs, resultOf, { lo: LO, hi: HI, maxSpread: MAXSPREAD, mult });
  if (!r.n) { console.log("  no entries met the filters"); continue; }

  console.log(`  entries            ${r.n}   (yes ${r.sides.yes} / no ${r.sides.no})`);
  console.log(`  avg entry price    ${fmt(r.avgEntry)}%`);
  console.log(`  win rate           ${fmt(r.winRate)}%`);
  console.log(`  breakeven needed   ${fmt(r.breakeven)}%   (price + fee)`);
  console.log(`  gross EV/contract  ${sign(r.grossPer)}${fmt(r.grossPer, 2)}c`);
  console.log(`  NET  EV/contract   ${sign(r.netPer)}${fmt(r.netPer, 2)}c   <-- the answer`);

  // Independence. Consecutive 15-minute windows ride the same
  // underlying path, so the trade count flatters the sample badly: the
  // honest denominator is closer to the number of DAYS.
  const days = new Set(mk.filter(m => obs.some(o => o.ticker === m.ticker))
                         .map(m => String(m.close_time).slice(0, 10)));
  console.log(`\n  distinct days      ${days.size}   <-- the real sample size, not ${r.n}`);
  console.log(`  edge over price    ${sign(r.edgeOverPrice)}${fmt(r.edgeOverPrice)}pt, ` +
              `SE ${fmt(r.se)}pt = ${(r.edgeOverPrice / (r.se || 1)).toFixed(1)} sigma ` +
              `IF trades were independent`);
  console.log(`  ...they are not: ${r.n} entries across ${days.size} days of one underlying.`);
  console.log(`\n  NOT MODELLED: fill. Kalshi publishes no size on this family`);
  console.log(`  (bid_size/ask_size are null), so every entry above assumes the`);
  console.log(`  whole order filled at the touch. Treat it as an UPPER BOUND.`);
}
