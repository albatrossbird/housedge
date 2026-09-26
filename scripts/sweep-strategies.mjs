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
import { collectEntries, score, realWin, nullDistribution, quantile, pValue, tStat, MIN_CELL_N }
  from "../lib/strategySweep.js";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? Number(h.split("=")[1]) : d; };
const DAYS = arg("days", 21);
const DRAWS = arg("draws", 400);
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString();

const SERIES = ["KXBTC15M", "KXGOLD15M"];

// EIGHT CELLS, NOT THIRTY-SIX, AND THE AXIS IS PRICE.
//
// The noise floor of a best-of-K grows with the family, so every cell
// that does not test the hypothesis makes the ones that do harder to
// see. The first sweep spent 36 cells covering price, side and time at
// once and could not separate any of them.
//
// The hypothesis is the FAVOURITE-LONGSHOT BIAS, which is documented on
// Kalshi specifically rather than borrowed from racetrack betting:
// cheap contracts win less often than their price implies and
// expensive ones slightly more, with sub-10c contracts reported losing
// over 60% of stake. That is a claim about PRICE LEVEL, so price gets
// the resolution and the other axes give theirs up.
//
// Both sides run because they are genuinely different books carrying
// different fees at different prices — not because the hypothesis needs
// them. One time window, because the time axis was exploratory and
// multiplying K by three to carry it would cost more in noise floor
// than it buys. T-180 is the choice: the widest coverage of the three
// in the first run, and three minutes is a window a person can trade
// rather than only a machine.
const BANDS = [[0.05, 0.15], [0.15, 0.35], [0.65, 0.85], [0.85, 0.95]];
const SIDES = ["yes", "no"];
const WINDOWS = [180];

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
  const r = await fetch(`${URL}/rest/v1/${p}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${p.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// ONE PAGER, SHARED. Seven scripts had their own copy of this and every
// one paged on `id` while filtering on `ticker` — so Postgres sorted the
// whole matching set instead of walking (ticker, observed_at), and each
// began failing with `57014 canceling statement due to statement
// timeout` as m15_quotes grew past a million rows. The analysis tooling
// stopped working because the data got big, which is the opposite of
// what more data is supposed to do.
//
// `key` must be a column the FILTER can use, and `dedupeOn` a unique one
// — see lib/restPage.js.
const readAll = (table, select, extra, key = "id", dedupeOn = null) =>
  pageAll(rest, table, select, String(extra).replace(/&+$/, ""), { key, dedupeOn });
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

let anyProven = false;

for (const s of SERIES) {
  const mult = await feeMultiplier(s);
  if (mult == null) { console.log(`::warning::${s}: no fee_multiplier from Kalshi — skipped rather than assumed`); continue; }

  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "close_time", "ticker");
  if (!mk.length) { console.log(`\n${s}: nothing settled in ${DAYS}d`); continue; }
  const resultOf = new Map(mk.map(m => [m.ticker, m.result]));
  const dayOf = new Map(mk.map(m => [m.ticker, String(m.close_time).slice(0, 10)]));

  const tickers = [...resultOf.keys()];
  const known = new Set(tickers);

  // READ A BAND AROUND EACH TARGET, NOT EVERYTHING UP TO THE WIDEST.
  //
  // Two reasons, and the second is the important one.
  //
  // Reading secs_to_close 0..600 in one query is ~7x the rows the
  // 90-second audit pulls, and it timed out on the first run with
  // 57014 — the same statement-timeout this repo keeps meeting when a
  // read is wider than the question.
  //
  // But it was also WRONG. pickOnePerTicker takes the row NEAREST the
  // target, so with a 0..600 read a market whose only quote sat at T-5
  // would be selected and scored as a "T-600 entry". That is not a
  // slower answer, it is a different strategy wearing the label of the
  // one being tested. The band makes the label true, and a market with
  // no quote near the target is DROPPED and COUNTED rather than
  // silently represented by a quote from a different moment.
  //
  // Tolerance scales with the target: at T-60 a quote 60s away is a
  // different market state, at T-600 it is barely a different one.
  const tol = w => Math.max(15, Math.round(w * 0.25));

  const obs = [];
  const coverage = [];
  for (const w of WINDOWS) {
    const rows = [];
    for (let i = 0; i < tickers.length; i += 120) {
      const ids = tickers.slice(i, i + 120).map(t => `"${t}"`).join(",");
      rows.push(...await readAll("m15_quotes", "id,ticker,secs_to_close,yes_bid,yes_ask",
        `ticker=in.(${encodeURIComponent(ids)})` +
        `&secs_to_close=gte.${Math.max(1, w - tol(w))}&secs_to_close=lte.${w + tol(w)}&`, "ticker", "id"));
    }
    // ONE OBSERVATION PER MARKET PER WINDOW. m15_quotes is
    // write-on-change, so counting rows weights the sample toward
    // volatile markets — exactly the ones likeliest to settle against
    // their quote.
    const picked = pickOnePerTicker(rows, w, { known });
    for (const r of picked) obs.push({ ...r, __w: w });
    coverage.push({ w, tol: tol(w), rows: rows.length, markets: picked.length,
                    dropped: tickers.length - picked.length });
  }

  // Each spec only sees observations picked for its own window.
  const per = specs.map((sp, i) =>
    collectEntries(obs.filter(o => o.__w === sp.entry.secsToClose.max), [sp])[0]);

  const rows = specs.map((sp, i) => {
    const r = per[i].length ? score(per[i], mult, realWin(resultOf), t => dayOf.get(t)) : null;
    return { label: sp.label, r };
  }).filter(x => x.r && x.r.n > 0);

  console.log(`${"=".repeat(74)}`);
  console.log(`${s}  (fee multiplier ${mult})  ${mk.length} settled markets`);
  console.log(`${"=".repeat(74)}`);
  // A sample that quietly shrinks teaches you to distrust it, so the
  // coverage per window is stated before any result that rests on it.
  for (const c of coverage) {
    console.log(`  T-${String(c.w).padStart(3)}s +/-${String(c.tol).padStart(3)}s: ` +
                `${String(c.markets).padStart(5)} of ${mk.length} markets have a quote in range` +
                ` (${c.dropped} without)`);
  }
  console.log();
  if (!rows.length) { console.log("  no variant took a single entry\n"); continue; }

  // EVERY cell is printed; only cells at the floor are ELIGIBLE to be
  // called best. A table that hides its thin cells hides the shape of
  // the data, and the floor is about what can be scored rather than
  // about what is interesting.
  for (const x of rows) { x.t = tStat(x.r); x.eligible = x.r.n >= MIN_CELL_N; }
  rows.sort((a, b) => (b.eligible - a.eligible) || (b.t - a.t));
  console.log(`  ${"variant".padEnd(26)} ${"n".padStart(5)} ${"days".padStart(5)} ${"win%".padStart(7)} ${"net/ct".padStart(8)} ${"t".padStart(7)}`);
  for (const { label, r, t, eligible } of rows) {
    console.log(`  ${label.padEnd(26)} ${String(r.n).padStart(5)} ${String(r.days).padStart(5)} ` +
                `${(100 * r.winRate).toFixed(1).padStart(6)}% ${pc(r.netPer).padStart(8)} ` +
                `${t.toFixed(2).padStart(7)}${eligible ? "" : `   (under n=${MIN_CELL_N}, not scored)`}`);
  }

  // THE CORRECTION. The best of N is not the same object as one test.
  const nd = nullDistribution(per, mult, { draws: DRAWS });
  const eligible = rows.filter(x => x.eligible);
  if (!eligible.length) {
    console.log(`\n  NOTHING ELIGIBLE: no cell has reached n=${MIN_CELL_N} yet.`);
    console.log(`  That is an answer about the SAMPLE, not about the strategies.`);
    console.log(`  Largest cell is ${Math.max(...rows.map(x => x.r.n))} entries.\n`);
    continue;
  }
  const best = eligible[0];
  const pT = pValue(nd.bestT, best.t);

  console.log(`\n  BEST (studentised): ${best.label}`);
  console.log(`    t ${best.t.toFixed(2)},  net ${pc(best.r.netPer)}c/contract` +
              ` on ${best.r.n} entries over ${best.r.days} days`);
  console.log(`\n  AGAINST A CALIBRATED-MARKET NULL (${nd.draws} worlds, ${nd.eligible} eligible cells)`);
  console.log(`    best t reached by NOISE       median ${quantile(nd.bestT, 0.5).toFixed(2)}` +
              `   95th ${quantile(nd.bestT, 0.95).toFixed(2)}`);
  console.log(`    ...and the net it came with   median ${pc(quantile(nd.bestNet, 0.5))}c` +
              `   95th ${pc(quantile(nd.bestNet, 0.95))}c`);
  console.log(`    p(noise >= our best t)  ${pT.toFixed(3)}`);
  // Harvey & Liu argue a newly proposed factor should clear t = 3.0
  // rather than 2.0, precisely because of multiple testing. Stated
  // beside the bootstrap as an independent reference point, not as a
  // second gate: the bootstrap already corrects for THIS family, and
  // applying a published haircut on top would charge for it twice.
  console.log(`    (Harvey & Liu's published bar for a new factor is t > 3.0)`);

  const pNet = pT;
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
console.log("  Fill is not modelled: rows recorded before 2026-09-26 carry no size");
console.log("  (the recorder read the wrong field), so every figure assumes the whole");
console.log("  order filled at the touch, and every net figure above is an UPPER");
console.log("  BOUND. Those prices are also up to 15s STALE — they came through a");
console.log("  CDN-cached feed. From that date book_bid/book_ask are the live touch.");
console.log("  The null assumes the market is calibrated, which is the hypothesis");
console.log("  a strategy must beat. It does NOT model adverse selection: in a");
console.log("  real book the fills you get are the ones someone wanted to give.");
if (!anyProven) {
  console.log("\n  Nothing in this grid survived its own multiplicity. That is a");
  console.log("  result about the SAMPLE, not about the strategies — the same");
  console.log("  sweep on more days may separate them, and re-running it is how");
  console.log("  you find out rather than assuming either way.");
}
