// Market-making study, Part B (docs/research/mm-plan.md): what do the
// fills cost a resting quote that Kalshi's Liquidity Incentive Program pays?
//
//   node scripts/mm-replay.mjs [--sweep=.lip-cache/sweep-....json] [--limit=N] [--pace=220] [--out=.lip-cache]
//
// Public endpoints only (/incentive_programs, /markets, /series, candles,
// /markets/trades): no key, no order, no Supabase. Three samples, all fixed
// by the plan before any tape was read:
//   richest: the 300 sweep-1 markets with the highest reward per dollar
//            (the better-paying of the join and supply quotes on each);
//   random:  300 of the rest whose quote exists, by a hash of the ticker;
//   ended:   300 markets whose program ended in the 14 days before sweep 1
//            and which have since settled, by the same hash, marked to
//            settlement.
// Downloaded tape is cached under --out/tape (gitignored) and never committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { replay, tickerHash, poolRateFor } from "../lib/mmReplay.js";
import { kalshiMakerFee } from "../lib/fees.js";
import { packCandle } from "../lib/m15Tape.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const OUT = opt("out", ".lip-cache"), PACE = Number(opt("pace", 220)), LIMIT = Number(opt("limit", 0));
const N = LIMIT || 300, DAY = 86400000, MIN = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, refused = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 7; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    let r;
    try { r = await fetch(B + path); } catch { await sleep(1500 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { refused++; const ra = Number(r.headers.get("retry-after")); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 7 tries`);
}

// ---- the sweep and the two open samples ----
const sweepFile = opt("sweep") || pathJoin(OUT, readdirSync(OUT).filter(f => /^sweep-.*\.json$/.test(f)).sort()[0]);
const sweep = JSON.parse(readFileSync(sweepFile, "utf8"));
const T0 = Math.floor(sweep.at / MIN) * MIN, FROM = T0 - 14 * DAY, BOUND = T0 - 7 * DAY;
const pick = r => {
  const useS = (r.supply?.perDay?.lenient || 0) > (r.join?.perDay?.lenient || 0), q = useS ? r.supply : r.join;
  const sizeYes = useS ? q.sizeYes : q.S, sizeNo = useS ? q.sizeNo : q.S;
  const suppliedPrice = useS && q.supplied ? Math.min(r.join.refYes == null ? q.priceYes : 1, r.join.refNo == null ? q.priceNo : 1) : null;
  // The dollars the quote puts on each side: the cap in the replay (mm-plan.md, run 1's bug).
  const budgetYes = sizeYes * (useS ? q.priceYes : q.refYes), budgetNo = sizeNo * (useS ? q.priceNo : q.refNo);
  return { ticker: r.ticker, series: r.series, model: useS ? "supply" : "join", pay: q.perDay.lenient, cost: q.cost, sizeYes, sizeNo, budgetYes, budgetNo, shareYes: q.shareYes, shareNo: q.shareNo, supplyEmpty: useS, cheap: suppliedPrice != null && suppliedPrice < 0.05 };
};
const quotes = sweep.rows.map(pick).filter(q => q.cost > 0 && q.sizeYes > 0 && q.sizeNo > 0);
const byRichness = quotes.filter(q => q.pay > 0).sort((a, b) => b.pay / b.cost - a.pay / a.cost);
const richest = byRichness.slice(0, N);
const richSet = new Set(richest.map(q => q.ticker));
const random = quotes.filter(q => !richSet.has(q.ticker)).sort((a, b) => tickerHash(a.ticker) - tickerHash(b.ticker)).slice(0, N);
const best25 = new Set(richest.filter(q => !q.cheap).slice(0, 25).map(q => q.ticker));
for (const q of richest) q.from = FROM, q.to = T0, q.boundary = BOUND;
for (const q of random) q.from = FROM, q.to = T0, q.boundary = BOUND;
console.log(`MARKET MAKING, PART B: the fills. Sweep ${new Date(sweep.at).toISOString()} (${sweep.rows.length} markets); open samples replayed ${new Date(FROM).toISOString().slice(0, 16)} .. ${new Date(T0).toISOString().slice(0, 16)}, weeks split at ${new Date(BOUND).toISOString().slice(0, 16)}`);
console.log(`  richest ${richest.length} (${richest.filter(q => q.model === "supply").length} supply quotes, ${richest.filter(q => q.cheap).length} of them supplying a side under 5c: reported apart), random ${random.length}, best 25 fixed now`);

// ---- every program that could touch a window ----
const programs = new Map();
const keepAfter = T0 - 30 * DAY;
for (const status of ["active", "closed", "paid_out"]) {
  let cursor = "", pages = 0, stale = 0;
  do {
    const d = await get(`/incentive_programs?status=${status}&type=liquidity&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const ps = (d?.incentive_programs || []).filter(p => p.incentive_type === "liquidity");
    for (const p of ps) if (Date.parse(p.end_date) >= keepAfter) { const a = programs.get(p.market_ticker) || []; if (!a.some(x => x.id === p.id)) a.push({ ...p, status }); programs.set(p.market_ticker, a); }
    // paid_out runs roughly newest first: stop after three whole pages older than we need.
    stale = ps.length && ps.every(p => Date.parse(p.end_date) < keepAfter) ? stale + 1 : 0;
    cursor = d?.next_cursor || ""; pages++;
  } while (cursor && stale < 3 && pages < 300);
  console.log(`  ${status} programs: ${pages} pages${cursor ? " (stopped once three pages were all older than 30 days)" : ""}`);
}

// ---- the ended sample ----
const swept = new Set(sweep.rows.map(r => r.ticker));
const endedCands = [...programs].filter(([t, ps]) => !swept.has(t) && ps.some(p => p.status !== "active" && Date.parse(p.end_date) >= FROM && Date.parse(p.end_date) < T0)).map(([t]) => t).sort((a, b) => tickerHash(a) - tickerHash(b));
const ended = [];
let endedRead = 0;
// /markets?tickers= returns any status, 50 at a time; kept in hash order.
for (let i = 0; i < endedCands.length && ended.length < N; i += 50) {
  const batch = endedCands.slice(i, i + 50);
  const d = await get(`/markets?tickers=${batch.map(encodeURIComponent).join(",")}&limit=50`); endedRead += batch.length;
  const got = new Map((d?.markets || []).map(m => [m.ticker, m]));
  for (const t of batch) {
    const m = got.get(t);
    if (ended.length >= N || !m || !["yes", "no"].includes(m.result) || !(Date.parse(m.close_time) <= Date.now())) continue;
    const to = Math.floor(Date.parse(m.close_time) / MIN) * MIN, start = Math.min(...programs.get(t).map(p => Date.parse(p.start_date)));
    ended.push({ ticker: t, series: programs.get(t)[0].series_ticker, model: "join", settle: m.result === "yes" ? 1 : 0, from: Math.max(Math.floor(start / MIN) * MIN, to - 14 * DAY), to, boundary: null });
  }
}
console.log(`  ended: ${endedCands.length} candidates, ${endedRead} read, ${ended.length} settled taken`);
// Their shares: the series' median sweep-1 JOIN share per side, else the overall median.
const med = a => a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : 0;
const joinRows = sweep.rows.filter(r => r.join?.S > 0);
const shareBySeries = new Map();
for (const r of joinRows) { const v = shareBySeries.get(r.series) || { y: [], n: [] }; v.y.push(r.join.shareYes); v.n.push(r.join.shareNo); shareBySeries.set(r.series, v); }
const allY = med(joinRows.map(r => r.join.shareYes)), allN = med(joinRows.map(r => r.join.shareNo));
let seriesShared = 0;
for (const q of ended) { const v = shareBySeries.get(q.series); if (v) seriesShared++; q.shareYes = v ? med(v.y) : allY; q.shareNo = v ? med(v.n) : allN; }
console.log(`  ended shares: ${seriesShared} from their series' median, ${ended.length - seriesShared} from the overall median (yes ${(100 * allY).toFixed(1)}%, no ${(100 * allN).toFixed(1)}%) -- an assumption`);

// ---- fees, tape, replay ----
const feeOf = new Map();
async function seriesFee(s) {
  if (!feeOf.has(s)) { const d = await get(`/series/${encodeURIComponent(s)}`); feeOf.set(s, d?.series ? { type: d.series.fee_type, mult: Number(d.series.fee_multiplier ?? 1) } : null); }
  return feeOf.get(s);
}
mkdirSync(pathJoin(OUT, "tape"), { recursive: true });
async function tape(q) {
  const file = pathJoin(OUT, "tape", `${q.ticker.replace(/[^A-Za-z0-9._-]/g, "_")}-${q.from}-${q.to}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const candles = [];
  for (let a = q.from - 60 * MIN; a < q.to; a += 4800 * MIN) {
    const b = Math.min(a + 4800 * MIN, q.to), qs = `candlesticks?start_ts=${a / 1000}&end_ts=${b / 1000}&period_interval=1`;
    let d = await get(`/series/${encodeURIComponent(q.series)}/markets/${encodeURIComponent(q.ticker)}/${qs}`);
    if (!d) d = await get(`/historical/markets/${encodeURIComponent(q.ticker)}/${qs}`);
    for (const k of d?.candlesticks || []) candles.push(packCandle(k));
  }
  const trades = [];
  let cursor = "", pages = 0, truncated = false;
  do {
    const d = await get(`/markets/trades?ticker=${encodeURIComponent(q.ticker)}&min_ts=${Math.floor(q.from / 1000)}&max_ts=${Math.ceil(q.to / 1000)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const x of d?.trades || []) trades.push({ t: Date.parse(x.created_time), price: Number(x.yes_price_dollars), count: Number(x.count_fp ?? x.count), taker: x.taker_side });
    cursor = d?.next_cursor || d?.cursor || ""; pages++;
    if ((d?.trades || []).length === 0) cursor = "";
    if (pages >= 200 && cursor) { truncated = true; break; }
  } while (cursor);
  candles.sort((a, b) => a[0] - b[0]); trades.sort((a, b) => a.t - b.t);
  const out = { candles, trades, truncated };
  writeFileSync(file + ".tmp", JSON.stringify(out)); writeFileSync(file, JSON.stringify(out));
  return out;
}

const results = { richest: [], random: [], ended: [] }, dropped = { richest: {}, random: {}, ended: {} };
const drop = (s, why) => { dropped[s][why] = (dropped[s][why] || 0) + 1; };
const t0 = Date.now();
let done = 0;
const total = richest.length + random.length + ended.length;
for (const [name, sample] of [["richest", richest], ["random", random], ["ended", ended]]) {
  for (const q of sample) {
    done++;
    if (done % 50 === 0) console.error(`  ${done}/${total} markets, ${requests} requests (${refused} refused), ${Math.round((Date.now() - t0) / 60000)} min`);
    const fee = await seriesFee(q.series);
    if (!fee || kalshiMakerFee(0.5, 1, fee.mult, fee.type) == null) { drop(name, `fee schedule not read (${fee?.type ?? "no series"})`); continue; }
    const tp = await tape(q);
    if (tp.truncated) { drop(name, "tape over 200 pages"); continue; }
    if (!tp.candles.length) { drop(name, "no candles"); continue; }
    if (name === "ended") {
      const first = tp.candles.find(c => c[0] >= q.from && c[1] > 0 && c[2] < 1 && c[1] < c[2]);
      if (!first) { drop(name, "never two-sided"); continue; }
      q.sizeYes = q.sizeNo = Math.floor((sweep.capital || 200) / (first[1] + 1 - first[2]));
      q.cost = q.sizeYes * (first[1] + 1 - first[2]);
      q.budgetYes = q.sizeYes * first[1]; q.budgetNo = q.sizeNo * (1 - first[2]);
    }
    const rate = poolRateFor(programs.get(q.ticker) || []);
    const args = { quotes: tp.candles, trades: tp.trades, from: q.from, to: q.to, sizeYes: q.sizeYes, sizeNo: q.sizeNo, budgetYes: q.budgetYes, budgetNo: q.budgetNo, shareYes: q.shareYes, shareNo: q.shareNo, fee: (p, c) => kalshiMakerFee(p, c, fee.mult, fee.type), poolRate: rate, quoteWhen: t => rate(t) > 0, supplyEmpty: q.supplyEmpty, boundary: q.boundary, settle: q.settle ?? null };
    const back = replay({ ...args, mode: "back" }), front = replay({ ...args, mode: "front" });
    if (!back.quoted) { drop(name, "no paid minute with a quote"); continue; }
    results[name].push({ ...q, back, front, days: (q.to - q.from) / DAY, trades: tp.trades.length });
  }
}

// ---- report ----
const $ = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
console.log(`\n${requests} requests (${refused} refused and retried), ${Math.round((Date.now() - t0) / 60000)} minutes of tape and replay`);
function report(label, rs, name) {
  console.log(`\n${label}: ${rs.length} replayed; dropped: ${Object.entries(dropped[name] || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log("  fills    markets  quoted days  fills  contracts   reward    fills P&L      net   net>0  median net/day  median $ tied up  vs mid per ctr: at fill  +1m  +10m  +60m");
  for (const mode of ["back", "front"]) {
    const R = rs.map(r => r[mode]);
    const vs = [0, 1, 2, 3].map(k => { const s = sum(R, x => x.vsMid[k].sum), c = sum(R, x => x.vsMid[k].q); return c ? (100 * s / c).toFixed(2) + "c" : "—"; });
    console.log(`  ${mode.padEnd(6)} ${String(rs.length).padStart(8)}  ${(sum(R, x => x.quoted) / 1440).toFixed(0).padStart(11)}  ${String(sum(R, x => x.fills)).padStart(5)}  ${sum(R, x => x.contracts).toFixed(0).padStart(9)}  ${$(sum(R, x => x.reward)).padStart(8)}  ${$(sum(R, x => x.pnl)).padStart(11)}  ${$(sum(R, x => x.reward + x.pnl)).padStart(8)}  ${String(R.filter(x => x.reward + x.pnl > 0).length).padStart(6)}  ${$(med(rs.map(r => (r[mode].reward + r[mode].pnl) / Math.max(r[mode].quoted / 1440, 1 / 24)))).padStart(14)}  ${$(med(R.map(x => x.maxCost))).padStart(16)}  ${vs.map(v => v.padStart(8)).join(" ")}`);
  }
}
const counted = results.richest.filter(r => !r.cheap), cheap = results.richest.filter(r => r.cheap);
report("RICHEST 300, counted toward the bar", counted, "richest");
if (cheap.length) report("RICHEST 300, supply quotes on a side under 5c (apart; never counted)", cheap, "x");
report("RANDOM 300 (the control)", results.random, "random");
report("ENDED 300 (marked to settlement; share assumed from the series)", results.ended, "ended");

// The bar, on the back bound.
const net = (r, w) => w == null ? r.back.reward + r.back.pnl : r.back.week[w].reward + r.back.week[w].pnl;
const enough = (r, w) => r.back.week[w].quoted >= 3 * 1440;
const half = counted.filter(r => net(r) > 0).length >= counted.length / 2;
const top = counted.filter(r => best25.has(r.ticker));
const wk = [0, 1].map(w => { const xs = top.filter(r => enough(r, w)); return { n: xs.length, out: top.length - xs.length, perDay: sum(xs, r => net(r, w)) / 7, cost: sum(xs, r => r.cost) }; });
console.log(`\nTHE BAR (richest 300 counted, back bound)`);
console.log(`  1. reward plus fills positive on ${counted.filter(r => net(r) > 0).length} of ${counted.length}: ${half ? "PASS" : "FAIL"} (needs half)`);
for (const w of [0, 1]) console.log(`  2. week ${w + 1}: the best 25 fixed before the replay, ${wk[w].n} with 3+ quoted days (${wk[w].out} left out), ${$(wk[w].perDay)} a day on ${$(wk[w].cost)}: ${wk[w].perDay >= 10 ? "PASS" : "FAIL"} (needs $10 a day)`);
for (const r of top) console.log(`     ${r.ticker.padEnd(36)} ${r.model.padEnd(6)} ${$(r.cost).padStart(8)}  wk1 ${$(net(r, 0)).padStart(8)} (${(r.back.week[0].quoted / 1440).toFixed(1)}d)  wk2 ${$(net(r, 1)).padStart(8)} (${(r.back.week[1].quoted / 1440).toFixed(1)}d)  reward ${$(r.back.reward).padStart(7)}  fills ${$(r.back.pnl).padStart(8)}`);
const endedNet = sum(results.ended, r => net(r));
console.log(`  3. the ended sample, total reward plus fills: ${$(endedNet)} over ${results.ended.length} markets: ${endedNet >= 0 ? "PASS" : "FAIL"} (a negative total fails Part B)`);
const w1 = counted.filter(r => enough(r, 0) && enough(r, 1)).sort((a, b) => net(b, 0) - net(a, 0)).slice(0, 25);
console.log(`  (reference, not the bar) the best 25 on week 1's net, scored on week 2: ${$(sum(w1, r => net(r, 1)) / 7)} a day on ${$(sum(w1, r => r.cost))}`);
const pass = half && wk[0].perDay >= 10 && wk[1].perDay >= 10 && endedNet >= 0;
console.log(`\nPART B: ${pass ? "PASS -> worth a written plan for a paper trial (a candidate, never a profit claim)" : "FAIL -> stop the study"}`);
console.log("Upper bounds throughout: the reward assumes every snapshot counted at the sweep-1 share and that nobody answered our quote.");
writeFileSync(pathJoin(OUT, `partb-${new Date(sweep.at).toISOString().replace(/[:.]/g, "")}.json`), JSON.stringify({ at: Date.now(), sweep: sweep.at, results, dropped }));
