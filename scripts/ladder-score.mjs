// Ladder consistency, the tape step. The plan: docs/research/ladder-plan.md.
//
//   node scripts/ladder-tape.mjs --size-pass      # first: the markets, into .ladder-cache/
//   node scripts/ladder-score.mjs --read          # every trade on every market in a live pair
//   node scripts/ladder-score.mjs --score         # the verdict
//
// --read pages /markets/trades for each market that has an implication
// partner which also traded, and caches each tape in .ladder-cache/tape/
// (gitignored: recorded Kalshi data is never committed). It resumes: a
// market already cached is not read again. Public endpoints, no key, no
// Supabase, paced under Kalshi's ~5 requests a second per IP.
//
// --score reads the cache only. A contradiction is a taker-NO print on X
// and a taker-YES print on Y, X implying Y, within the window, costing
// under $1 after both taker fees (lib/ladder.js). Each print's contracts
// are used once. Days are UTC days of the group's CLOSE, so each market's
// whole life lands in exactly one of the 14 days.
//
// The verdict (fixed in the plan): the 1-second window, fees rounded to
// $0.0001, passes only if the 14 days total $140 or more AND at least 7
// days carry $5 or more. Every figure is an upper bound.
//
// No verdict is printed while any needed tape is missing.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { implicationPairs, contradictionCandidates, allocate, seriesOfTicker } from "../lib/ladder.js";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const CACHE = opt("cache", ".ladder-cache");
const TAPES = join(CACHE, "tape");
const PACE = Number(opt("pace", 220));
const READ = process.argv.includes("--read"), SCORE = process.argv.includes("--score");
if (READ === SCORE) { console.error("pass exactly one of --read or --score"); process.exit(2); }

// The plan's fixed settings.
const VERDICT = { windowMs: 1000, precision: 0.0001 };
const RUNS = [
  { name: "100ms", windowMs: 100, precision: 0.0001 },
  { name: "1s (verdict)", windowMs: 1000, precision: 0.0001 },
  { name: "5s", windowMs: 5000, precision: 0.0001 },
  { name: "1s, cent fees", windowMs: 1000, precision: 0.01 },
];
const PASS_TOTAL = 140, PASS_DAY = 5, PASS_DAYS = 7;
const BOT_MS = 50;

const sp = JSON.parse(readFileSync(join(CACHE, "size-pass.json"), "utf8"));
const SINCE = Date.parse(`${sp.since}T00:00:00Z`);
const DAYS = Math.round((Date.parse(`${sp.until}T00:00:00Z`) - SINCE) / 86400000) + 1;

// Markets in a live pair: both legs traded. The same rule as the size pass.
const groups = new Map();
for (const m of sp.markets) { if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }
const byTicker = new Map(sp.markets.map(m => [m.ticker, m]));
const need = new Set(), liveGroups = [];
for (const [g, ms] of groups) {
  const traded = ms.filter(m => m.volume > 0);
  if (traded.length < 2) continue;
  const pairs = implicationPairs(traded);
  if (!pairs.length) continue;
  liveGroups.push(g);
  for (const [x, y] of pairs) { need.add(x); need.add(y); }
}
const tapePath = t => join(TAPES, `${t}.json.gz`);
mkdirSync(TAPES, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 7; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    let r;
    try { r = await fetch(B + path); } catch (e) { await sleep(1500 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i);
      continue;
    }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 7 tries`);
}

if (READ) {
  // Fee multipliers per series, stored beside the tapes for --score. The
  // size pass found x1 on every series and no change in the window; this
  // reads them again rather than assuming.
  const fees = {};
  for (const s of [...new Set([...need].map(seriesOfTicker))].sort()) {
    const r = await get(`/series/${s}`);
    const ser = r.series || r;
    fees[s] = { multiplier: Number(ser.fee_multiplier ?? 1), type: ser.fee_type };
  }
  writeFileSync(join(CACHE, "fees.json"), JSON.stringify(fees));
  console.log(`fees: ${JSON.stringify(fees)}`);

  const todo = [...need].sort().filter(t => !existsSync(tapePath(t)));
  console.log(`tapes: ${need.size} needed, ${need.size - todo.length} cached, ${todo.length} to read`);
  const t0 = Date.now(), failed = [];
  let trades = 0, done = 0;
  for (const t of todo) {
    try {
      const out = [];
      let cursor = "";
      do {
        const page = await get(`/markets/trades?ticker=${encodeURIComponent(t)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const raw of page.trades || []) {
          if (raw.ticker && raw.ticker !== t) throw new Error(`asked for ${t}, got a trade on ${raw.ticker}`);
          const p = parseTrade(raw);
          if (p) out.push([p.t, p.side === "yes" ? 1 : 0, p.price, p.count]);
        }
        cursor = page.cursor || "";
      } while (cursor);
      out.sort((a, b) => a[0] - b[0]);
      writeFileSync(tapePath(t), gzipSync(JSON.stringify(out)));
      trades += out.length;
    } catch (e) {
      failed.push(`${t}: ${e.message}`);
    }
    done++;
    if (done % 250 === 0 || done === todo.length) {
      const el = (Date.now() - t0) / 60000;
      console.log(`  ${done}/${todo.length} markets, ${trades.toLocaleString("en-US")} trades, ${requests} requests, ${el.toFixed(1)} min, ~${(el / done * (todo.length - done)).toFixed(0)} min left by market count`);
    }
  }
  console.log(`read done: ${trades.toLocaleString("en-US")} trades, ${requests} requests, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED ${f}`);
  if (failed.length) process.exit(1);
}

if (SCORE) {
  const missing = [...need].filter(t => !existsSync(tapePath(t)));
  const feesPath = join(CACHE, "fees.json");
  if (!existsSync(feesPath)) { console.error("::error::no fees.json; run --read first"); process.exit(1); }
  const fees = JSON.parse(readFileSync(feesPath, "utf8"));
  const feeFor = precision => (p, n, ticker) => {
    const f = fees[seriesOfTicker(ticker)];
    if (!f) throw new Error(`no fee for ${ticker}`);
    return kalshiTakerFee(p, n, f.multiplier, precision);
  };
  const loadTape = t => existsSync(tapePath(t))
    ? JSON.parse(gunzipSync(readFileSync(tapePath(t)))).map(([t, s, price, count]) => ({ t, side: s ? "yes" : "no", price, count }))
    : [];

  const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
  const allDays = Array.from({ length: DAYS }, (_, i) => dayOf(SINCE + i * 86400000));
  const res = RUNS.map(r => ({ ...r, fee: feeFor(r.precision), total: 0, contracts: 0, n: 0, byDay: Object.fromEntries(allDays.map(d => [d, 0])) }));
  const v = res.find(r => r.windowMs === VERDICT.windowMs && r.precision === VERDICT.precision);
  const bySeries = new Map(), byTtc = new Map(), byBid = new Map(), top = [];
  let botContracts = 0, botEdge = 0, candTotal = 0, printsRead = 0;
  const bump = (m, k, e, c) => { const x = m.get(k) || { edge: 0, contracts: 0, n: 0 }; x.edge += e; x.contracts += c; x.n++; m.set(k, x); };
  const ttcBucket = s => s < 60 ? "<1m" : s < 300 ? "1-5m" : s < 900 ? "5-15m" : s < 3600 ? "15-60m" : s < 86400 ? "1-24h" : ">24h";
  const bidBucket = b => b < 0.1 ? "<10c" : b < 0.3 ? "10-30c" : b < 0.7 ? "30-70c" : b < 0.9 ? "70-90c" : ">=90c";

  let gi = 0;
  for (const g of liveGroups) {
    const ms = groups.get(g).filter(m => need.has(m.ticker));
    const tapes = new Map(ms.map(m => [m.ticker, loadTape(m.ticker)]));
    for (const p of tapes.values()) printsRead += p.length;
    const cands = contradictionCandidates(ms.map(m => ({ ticker: m.ticker, ev: m.ev })), tapes, { maxWindowMs: 5000, fee: feeFor(0.0001) });
    candTotal += cands.length;
    const close = ms[0].close, day = dayOf(close);
    for (const r of res) {
      for (const a of allocate(cands, { windowMs: r.windowMs, fee: r.fee })) {
        r.total += a.edge; r.contracts += a.size; r.n++; r.byDay[day] += a.edge;
        if (r !== v) continue;
        const dt = Math.abs(a.tX - a.tY);
        if (dt <= BOT_MS) { botContracts += a.size; botEdge += a.edge; }
        bump(bySeries, `${seriesOfTicker(a.x)} > ${seriesOfTicker(a.y)}`, a.edge, a.size);
        bump(byTtc, ttcBucket((close - Math.min(a.tX, a.tY)) / 1000), a.edge, a.size);
        bump(byBid, bidBucket(1 - a.noPrice), a.edge, a.size);
        top.push({ ...a, dt }); if (top.length > 400) { top.sort((p, q) => q.edge - p.edge); top.length = 30; }
      }
    }
    if (++gi % 500 === 0) console.error(`  scored ${gi}/${liveGroups.length} groups`);
  }

  const $ = x => `$${x.toFixed(2)}`;
  const fmt = n => Math.round(n).toLocaleString("en-US");
  console.log(`window ${sp.since} .. ${sp.until} (${DAYS} days); ${liveGroups.length} groups, ${need.size} markets, ${fmt(printsRead)} prints; ${fmt(candTotal)} candidate pairs within 5s`);
  if (missing.length) console.log(`::warning::${missing.length} tapes missing, e.g. ${missing.slice(0, 5).join(", ")}`);
  console.log(`\n| run | contradictions | contracts | after-fee edge | per day | days >= $${PASS_DAY} |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const r of res) {
    const d5 = Object.values(r.byDay).filter(x => x >= PASS_DAY).length;
    console.log(`| ${r.name} | ${fmt(r.n)} | ${fmt(r.contracts)} | ${$(r.total)} | ${$(r.total / DAYS)} | ${d5} of ${DAYS} |`);
  }
  console.log(`\nverdict run by UTC day of close:`);
  for (const d of allDays) console.log(`  ${d}  ${$(v.byDay[d])}`);
  const table = (title, m) => {
    console.log(`\n${title}:`);
    for (const [k, x] of [...m].sort((a, b) => b[1].edge - a[1].edge)) console.log(`  ${k.padEnd(22)} ${$(x.edge).padStart(10)}  ${fmt(x.contracts).padStart(10)} contracts  ${String(x.n).padStart(7)} pairs`);
  };
  table("verdict run by series (NO on X > YES on Y)", bySeries);
  table("verdict run by time to close at the first print", byTtc);
  table("verdict run by X's YES bid", byBid);
  console.log(`\nprinted within ${BOT_MS}ms of each other: ${fmt(botContracts)} of ${fmt(v.contracts)} contracts (${v.contracts ? (100 * botContracts / v.contracts).toFixed(1) : 0}%), ${$(botEdge)} of ${$(v.total)}`);
  top.sort((p, q) => q.edge - p.edge);
  console.log(`\nlargest verdict-run contradictions:`);
  for (const a of top.slice(0, 15)) console.log(`  ${$(a.edge).padStart(8)}  ${a.size.toFixed(2).padStart(9)} ctr  NO ${a.x} @${a.noPrice}  YES ${a.y} @${a.yesPrice}  dt ${a.dt}ms  ${new Date(Math.min(a.tX, a.tY)).toISOString()}`);

  const d5 = Object.values(v.byDay).filter(x => x >= PASS_DAY).length;
  if (missing.length) { console.log(`\nverdict: NONE (${missing.length} tapes missing)`); process.exit(1); }
  const pass = v.total >= PASS_TOTAL && d5 >= PASS_DAYS;
  console.log(`\nverdict: ${pass ? "PASS" : "STOP"} (${$(v.total)} against $${PASS_TOTAL}; ${d5} of ${DAYS} days at $${PASS_DAY}+ against ${PASS_DAYS})`);
}
