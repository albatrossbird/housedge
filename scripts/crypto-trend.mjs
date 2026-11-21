// Crypto trend, long or flat (docs/research/crypto-trend-plan.md).
//   node scripts/crypto-trend.mjs --plumbing   data checks only
//   node scripts/crypto-trend.mjs --score      the bar and the reference rows
// Public Coinbase daily candles, cached under .algo-cache/ (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }
const CACHE = ".algo-cache", DAY = 86400000;
mkdirSync(CACHE, { recursive: true });
const START = { "BTC-USD": "2015-07-20", "ETH-USD": "2016-05-18", "SOL-USD": "2021-06-01" };
// --last=<YYYY-MM-DD> reads closes to that day and adds the paper record:
// the primary rule on days after 2026-11-20 and the position it holds now.
const LASTARG = (process.argv.find(x => x.startsWith("--last=")) || "").slice(7);
const LAST = LASTARG || "2026-11-20";   // last close used

const sleep = ms => new Promise(r => setTimeout(r, ms));
let req = 0;
async function getJson(url) {
  for (let i = 0; i < 6; i++) {
    req++; await sleep(200);
    let r;
    try { r = await fetch(url); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${url.slice(0, 120)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${url.slice(0, 120)}: failed after 6 tries`);
}
// daily closes by UTC date, from the coin's start to LAST
async function closes(product) {
  const f = join(CACHE, `${product}-daily-${LAST}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const out = {};
  const end = Date.parse(`${LAST}T00:00:00Z`) + DAY;
  for (let t = Date.parse(`${START[product]}T00:00:00Z`); t < end; t += 300 * DAY) {
    const s = new Date(t).toISOString(), e = new Date(Math.min(t + 300 * DAY, end)).toISOString();
    const d = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${s}&end=${e}`);
    for (const [ts, , , , close] of d || []) { const day = new Date(ts * 1000).toISOString().slice(0, 10); if (day <= LAST) out[day] = close; }
  }
  writeFileSync(f + ".tmp", JSON.stringify(out)); renameSync(f + ".tmp", f);
  return out;
}

const series = {};
console.log(`CRYPTO TREND, LONG OR FLAT: ${SCORE ? "SCORE" : "PLUMBING"}; Coinbase daily closes to ${LAST}`);
let ok = true;
for (const p of Object.keys(START)) {
  const c = await closes(p), days = Object.keys(c).sort();
  let missing = 0;
  for (let i = 1; i < days.length; i++) missing += Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY) - 1;
  const bad = days.filter(d => !(c[d] > 0)).length;
  const okP = missing / (days.length + missing) < 0.005 && !bad && days[days.length - 1] === LAST;
  if (!okP) ok = false;
  console.log(`  ${p}: ${days.length} days ${days[0]}..${days[days.length - 1]}, missing ${missing}, bad ${bad}${okP ? "" : "  <- FAILS"}`);
  series[p] = { c, days };
}
console.log(ok ? "PLUMBING: clears" : "PLUMBING FAILS");
if (!SCORE) { console.log(`requests ${req}`); process.exit(0); }
if (!ok) process.exit(1);

// daily strategy returns for one coin, keyed by the day the return is earned (close of day-1 to close of day)
function coinReturns(p, { L = 30, fee = 0.004, mode = "flat" } = {}) {
  const { c, days } = series[p], out = {}, hold = {};
  let prev = null;
  for (let i = L; i < days.length - 1; i++) {
    const d0 = days[i], back = days[i - L], d1 = days[i + 1];
    if (Math.round((Date.parse(d0) - Date.parse(back)) / DAY) > L + 3) continue;   // a gap in the lookback
    const sig = c[d0] / c[back] - 1 > 0 ? 1 : (mode === "short" ? -1 : 0);
    const ret = c[d1] / c[d0] - 1;
    let r = sig * ret;
    if (prev !== null && sig !== prev) r -= fee * Math.abs(sig - prev);
    out[d1] = r; hold[d1] = sig !== 0; prev = sig;
  }
  return { out, hold };
}
function bhReturns(p) { const { c, days } = series[p], out = {}; for (let i = 1; i < days.length; i++) out[days[i]] = c[days[i]] / c[days[i - 1]] - 1; return out; }
function pool(list, from, to) {
  const days = Object.keys(list[0]).filter(d => d >= from && d <= to && list.every(x => x[d] !== undefined)).sort();
  return days.map(d => list.reduce((a, x) => a + x[d], 0) / list.length);
}
function stats(rs) {
  const n = rs.length, m = rs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  let eq = 1, peak = 1, dd = 0;
  for (const r of rs) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
  return { n, sharpe: m / sd * Math.sqrt(365), total: eq - 1, ann: eq ** (365 / n) - 1, dd };
}
const fmt = (label, s, extra = "") => `  ${label.padEnd(38)} Sharpe ${s.sharpe.toFixed(2).padStart(5)}  a year ${(100 * s.ann).toFixed(1).padStart(6)}%  total ${(100 * s.total).toFixed(0).padStart(6)}%  worst drawdown ${(100 * s.dd).toFixed(0).padStart(4)}%  days ${s.n}${extra}`;

const A = "2021-01-01", MID = "2023-12-31", B = "2024-01-01", Z = "2026-11-20";
const coins = ["BTC-USD", "ETH-USD"];
function run(opts, from = A, to = Z, list = coins) {
  const per = list.map(p => coinReturns(p, opts));
  const rs = pool(per.map(x => x.out), from, to);
  const holdDays = list.map(p => coinReturns(p, opts).hold);
  const inv = pool(holdDays.map(h => Object.fromEntries(Object.entries(h).map(([d, v]) => [d, v ? 1 : 0]))), from, to);
  const sw = per.reduce((a, x) => { const ds = Object.keys(x.hold).filter(d => d >= from && d <= to).sort(); let s = 0; for (let i = 1; i < ds.length; i++) if (x.hold[ds[i]] !== x.hold[ds[i - 1]]) s++; return a + s; }, 0);
  return { s: stats(rs), invested: inv.reduce((a, b) => a + b, 0) / inv.length, switches: sw };
}

console.log(`\nTHE PRIMARY: BTC + ETH half each, long while the past 30 days are up, else cash, 0.40% a switch; ${A}..${Z}`);
const P = run({}), BH = stats(pool(coins.map(bhReturns), A, Z));
const H1 = run({}, A, MID), H2 = run({}, B, Z);
console.log(fmt("trend, long or flat", P.s, `  invested ${(100 * P.invested).toFixed(0)}%  switches ${P.switches}`));
console.log(fmt("buy and hold", BH));
console.log(fmt(`  first half ${A}..${MID}`, H1.s));
console.log(fmt(`  second half ${B}..${Z}`, H2.s));
const t1 = P.s.sharpe >= 0.5, t2 = P.s.sharpe > BH.sharpe, t3 = H1.s.total > 0 && H2.s.total > 0;
console.log(`VERDICT: ${t1 && t2 && t3 ? "PASS" : "FAIL"}  (Sharpe ${P.s.sharpe.toFixed(2)} needs 0.5: ${t1 ? "ok" : "no"}; above buy-and-hold ${BH.sharpe.toFixed(2)}: ${t2 ? "ok" : "no"}; positive in both halves: ${t3 ? "ok" : "no"})`);

console.log("\nREFERENCE ONLY (never a second chance)");
console.log(fmt("buy and hold, first half", stats(pool(coins.map(bhReturns), A, MID))));
console.log(fmt("buy and hold, second half", stats(pool(coins.map(bhReturns), B, Z))));
for (const L of [7, 14, 60, 90, 180]) console.log(fmt(`lookback ${L} days`, run({ L }).s));
for (const fee of [0.001, 0.008]) console.log(fmt(`fee ${(fee * 100).toFixed(2)}% a switch`, run({ fee }).s));
for (const p of coins) { console.log(fmt(`${p} alone`, run({}, A, Z, [p]).s)); console.log(fmt(`${p} buy and hold`, stats(pool([bhReturns(p)], A, Z)))); }
console.log(fmt("SOL-USD alone (from 2021-07)", run({}, A, Z, ["SOL-USD"]).s));
console.log(fmt("SOL-USD buy and hold", stats(pool([bhReturns("SOL-USD")], "2021-07-01", Z))));
console.log(fmt("2016-07..2020-12, BTC + ETH", run({}, "2016-07-01", "2020-12-31").s));
console.log(fmt("  buy and hold, same period", stats(pool(coins.map(bhReturns), "2016-07-01", "2020-12-31"))));
console.log(fmt("long or short (perp, 0.12% a switch)", run({ mode: "short", fee: 0.0012 }).s));
if (LASTARG) {
  console.log(`\nPAPER RECORD: the primary rule on 2026-11-21..${LAST}`);
  const F = run({}, "2026-11-21", LAST), FB = stats(pool(coins.map(bhReturns), "2026-11-21", LAST));
  console.log(fmt("trend, long or flat", F.s, `  switches ${F.switches}`)); console.log(fmt("buy and hold", FB));
  for (const p of coins) { const { c, days } = series[p], d = days[days.length - 1], b = days[days.length - 31]; console.log(`  ${p} at the ${d} close: past 30 days ${(100 * (c[d] / c[b] - 1)).toFixed(1)}% -> ${c[d] / c[b] > 1 ? "HOLD the coin" : "CASH"} for the next day`); }
}
console.log(`\nrequests ${req}. Upper bound: fills at the daily close, the entry-tier fee, cash earning nothing, no tax.`);
