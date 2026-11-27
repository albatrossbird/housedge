// Crypto trend across more coins (docs/research/crypto-multi-trend-plan.md).
//   node scripts/crypto-multi-trend.mjs --plumbing   which coins are in, data checks
//   node scripts/crypto-multi-trend.mjs --score      the bar and the reference rows
// Public Coinbase daily candles, cached under .algo-cache/ (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }
// --last=<YYYY-MM-DD> reads closes to that day and adds the paper record (days after 2026-11-20)
const LASTARG = (process.argv.find(x => x.startsWith("--last=")) || "").slice(7);
const CACHE = ".algo-cache", DAY = 86400000, LAST = LASTARG || "2026-11-20", JOIN_AFTER = 60;
mkdirSync(CACHE, { recursive: true });
// Kalshi's crypto perp coins (2026-11-19) minus BTC, ETH and SOL, which the first test already read
const SCORED = ["AAVE", "ADA", "BCH", "BNB", "DOGE", "HYPE", "LINK", "LTC", "NEAR", "SHIB", "SUI", "UNI", "VVV", "WLD", "XRP", "ZEC"];
const SEEN = ["BTC", "ETH", "SOL"];

const sleep = ms => new Promise(r => setTimeout(r, ms));
let req = 0;
async function get(url) {
  for (let i = 0; i < 6; i++) {
    req++; await sleep(200);
    let r;
    try { r = await fetch(url); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${url.slice(0, 120)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${url.slice(0, 120)}: failed after 6 tries`);
}
// daily closes by UTC date, from listing to LAST; null if Coinbase has no such product
async function closes(coin) {
  const f = join(CACHE, `${coin}-USD-daily-${LAST}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const p = await get(`https://api.exchange.coinbase.com/products/${coin}-USD`);
  let out = null;
  if (p) {
    out = {};
    const end = Date.parse(`${LAST}T00:00:00Z`) + DAY;
    for (let t = Date.parse("2016-01-01T00:00:00Z"); t < end; t += 300 * DAY) {
      const s = new Date(t).toISOString(), e = new Date(Math.min(t + 300 * DAY, end)).toISOString();
      const d = await get(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400&start=${s}&end=${e}`);
      for (const [ts, , , , close] of d || []) { const day = new Date(ts * 1000).toISOString().slice(0, 10); if (day <= LAST && close > 0) out[day] = close; }
    }
  }
  writeFileSync(f + ".tmp", JSON.stringify(out)); renameSync(f + ".tmp", f);
  return out;
}

console.log(`CRYPTO TREND ACROSS MORE COINS: ${SCORE ? "SCORE" : "PLUMBING"}; Coinbase daily closes to ${LAST}`);
const series = {};
for (const coin of [...SCORED, ...SEEN]) {
  const c = await closes(coin);
  if (!c || !Object.keys(c).length) { console.log(`  ${coin}: not on Coinbase (no ${coin}-USD product or no candles): out`); continue; }
  const days = Object.keys(c).sort();
  let missing = 0; for (let i = 1; i < days.length; i++) missing += Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY) - 1;
  const okC = days[days.length - 1] === LAST && missing / (days.length + missing) < 0.01;
  console.log(`  ${coin}: ${days.length} days ${days[0]}..${days[days.length - 1]}, missing ${missing}${okC ? "" : "  <- out (stale or gappy)"}${SEEN.includes(coin) ? "  (reference only)" : ""}`);
  if (okC) series[coin] = { c, days, joins: new Date(Date.parse(days[0]) + JOIN_AFTER * DAY).toISOString().slice(0, 10) };
}
const IN = SCORED.filter(c => series[c]);
console.log(`scored basket: ${IN.length} coins (${IN.join(", ")})`);
if (!SCORE) { console.log(`requests ${req}`); process.exit(0); }
if (IN.length < 5) { console.log("PLUMBING FAILS: fewer than 5 coins"); process.exit(1); }

// per coin: strategy return earned on day d1 (close d0 -> close d1), keyed by d1; only once the coin has joined
function coinReturns(coin, { L = 30, fee = 0.004, mode = "flat" } = {}) {
  const { c, days, joins } = series[coin], out = {};
  let prev = 0;
  for (let i = L; i < days.length - 1; i++) {
    const d0 = days[i], back = days[i - L], d1 = days[i + 1];
    if (d0 < joins) continue;
    if (Math.round((Date.parse(d0) - Date.parse(back)) / DAY) > L + 3) continue;
    const sig = c[d0] / c[back] - 1 > 0 ? 1 : (mode === "short" ? -1 : 0);
    let r = sig * (c[d1] / c[d0] - 1);
    if (sig !== prev) r -= fee * Math.abs(sig - prev);
    out[d1] = r; prev = sig;
  }
  return out;
}
function bhReturns(coin) { const { c, days, joins } = series[coin], out = {}; for (let i = 1; i < days.length; i++) if (days[i - 1] >= joins) out[days[i]] = c[days[i]] / c[days[i - 1]] - 1; return out; }
// equal weight across whichever coins have a return that day
function basket(list, from, to) {
  const days = [...new Set(list.flatMap(x => Object.keys(x)))].filter(d => d >= from && d <= to).sort();
  return days.map(d => { const xs = list.map(x => x[d]).filter(v => v !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; });
}
function stats(rs) {
  const n = rs.length, m = rs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  let eq = 1, pk = 1, dd = 0; for (const r of rs) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  return { n, sharpe: m / sd * Math.sqrt(365), total: eq - 1, ann: eq ** (365 / n) - 1, dd };
}
const fmt = (label, s) => `  ${label.padEnd(40)} Sharpe ${s.sharpe.toFixed(2).padStart(5)}  a year ${(100 * s.ann).toFixed(1).padStart(7)}%  total ${(100 * s.total).toFixed(0).padStart(7)}%  worst drawdown ${(100 * s.dd).toFixed(0).padStart(4)}%  days ${s.n}`;
const A = "2021-01-01", MID = "2023-12-31", B = "2024-01-01", Z = "2026-11-20";
const run = (opts = {}, coins = IN, from = A, to = Z) => stats(basket(coins.map(c => coinReturns(c, opts)), from, to));
const hold = (coins = IN, from = A, to = Z) => stats(basket(coins.map(bhReturns), from, to));

const joinedBy = d => IN.filter(c => series[c].joins <= d).length;
console.log(`\nbasket size: ${joinedBy(A)} coins on ${A}, ${joinedBy(B)} on ${B}, ${joinedBy(Z)} on ${Z}`);
console.log(`\nTHE PRIMARY: each coin long while its past 30 days are up, else cash, equal weight, 0.40% a switch; ${A}..${Z}`);
const P = run(), BH = hold(), H1 = run({}, IN, A, MID), H2 = run({}, IN, B, Z);
console.log(fmt("trend, long or flat", P)); console.log(fmt("equal-weight buy and hold", BH));
console.log(fmt(`  first half ${A}..${MID}`, H1)); console.log(fmt(`  second half ${B}..${Z}`, H2));
console.log(fmt("  buy and hold, first half", hold(IN, A, MID))); console.log(fmt("  buy and hold, second half", hold(IN, B, Z)));
const t1 = P.sharpe >= 0.5, t2 = P.sharpe > BH.sharpe, t3 = H1.total > 0 && H2.total > 0;
console.log(`VERDICT: ${t1 && t2 && t3 ? "PASS" : "FAIL"}  (Sharpe ${P.sharpe.toFixed(2)} needs 0.5: ${t1 ? "ok" : "no"}; above buy-and-hold ${BH.sharpe.toFixed(2)}: ${t2 ? "ok" : "no"}; positive in both halves: ${t3 ? "ok" : "no"})`);

console.log("\nREFERENCE ONLY (never a second chance)");
for (const L of [14, 60]) console.log(fmt(`lookback ${L} days`, run({ L })));
console.log(fmt("fee 0.12% a switch", run({ fee: 0.0012 })));
console.log(fmt("long or short (perp, 0.12%), funding ignored", run({ mode: "short", fee: 0.0012 })));
const ALL = [...IN, ...SEEN.filter(c => series[c])];
console.log(fmt("all coins incl. BTC, ETH, SOL", run({}, ALL))); console.log(fmt("  buy and hold, same", hold(ALL)));
for (const c of IN) { const t = run({}, [c]), h = hold([c]); console.log(fmt(`${c} alone (from ${series[c].joins > A ? series[c].joins : A})`, t) + `   hold: Sharpe ${h.sharpe.toFixed(2)}, worst ${(100 * h.dd).toFixed(0)}%`); }
if (LASTARG) {
  console.log(`\nPAPER RECORD: the primary rule on 2026-11-21..${LAST}`);
  console.log(fmt("trend, long or flat", run({}, IN, "2026-11-21", LAST))); console.log(fmt("equal-weight buy and hold", hold(IN, "2026-11-21", LAST)));
  const held = IN.filter(c => { const { c: px, days } = series[c], d = days[days.length - 1], b = days[days.length - 31]; return px[d] > px[b]; });
  console.log(`  at the ${LAST} close: holding ${held.length} of ${IN.length} (${held.join(", ") || "none"}); the rest in cash`);
}
console.log(`\nrequests ${req}. Upper bound: fills at the daily close, the entry-tier fee, cash earning nothing, no tax, today's surviving coins.`);
