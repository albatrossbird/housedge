// FX trend and carry on the majors (docs/research/fx-plan.md).
//   node scripts/fx-trend-carry.mjs --plumbing   data checks only
//   node scripts/fx-trend-carry.mjs --score      both bars and the reference rows
// Public FRED series, cached under .algo-cache/ (gitignored).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }
const CACHE = ".algo-cache", LAST = "2026-11-20";
mkdirSync(CACHE, { recursive: true });

// currency: [FRED daily id, true if the series is USD per unit (else units per USD), 3-month rate id, fallback daily id after it ends]
const CCY = {
  EUR: ["DEXUSEU", true, "IR3TIB01EZM156N", "ECBDFR"],
  JPY: ["DEXJPUS", false, "IR3TIB01JPM156N", null],
  GBP: ["DEXUSUK", true, "IR3TIB01GBM156N", "IUDSOIA"],
  CAD: ["DEXCAUS", false, "IR3TIB01CAM156N", null],
  CHF: ["DEXSZUS", false, "IR3TIB01CHM156N", null],
  AUD: ["DEXUSAL", true, "IR3TIB01AUM156N", null],
  NZD: ["DEXUSNZ", true, "IR3TIB01NZM156N", null],
};
const US_RATE = "IR3TIB01USM156N";

async function fred(id) {
  const f = join(CACHE, `fred-${id}-${LAST}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  let text = null;   // FRED resets requests carrying Node's default agent, hence the header
  for (let i = 0; i < 5 && text === null; i++) {
    try { const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, { headers: { "User-Agent": "curl/8.5.0" } }); if (r.ok) text = await r.text(); } catch {}
    if (text === null) await new Promise(r => setTimeout(r, 3000 * 2 ** i));
  }
  if (text === null) throw new Error(`FRED ${id}: failed`);
  const out = {};
  for (const line of text.split("\n").slice(1)) { const [d, v] = line.split(","); const x = Number(v); if (d && v !== "" && v !== "." && Number.isFinite(x) && d <= LAST) out[d.trim()] = x; }
  writeFileSync(f + ".tmp", JSON.stringify(out)); renameSync(f + ".tmp", f);
  return out;
}
const monthOf = d => d.slice(0, 7);
function monthly(series) { const m = {}; for (const [d, v] of Object.entries(series)) m[monthOf(d)] = v; return m; }
function monthlyMean(series) { const s = {}, n = {}; for (const [d, v] of Object.entries(series)) { const k = monthOf(d); s[k] = (s[k] || 0) + v; n[k] = (n[k] || 0) + 1; } const m = {}; for (const k in s) m[k] = s[k] / n[k]; return m; }

// ---- load ----
const value = {}, rate = {};
for (const [c, [id, direct, rid, fb]] of Object.entries(CCY)) {
  const s = await fred(id); value[c] = {};
  for (const [d, v] of Object.entries(s)) if (v > 0) value[c][d] = direct ? v : 1 / v;
  const r = monthly(await fred(rid)), last = Object.keys(r).sort().pop();
  if (fb) { const f = monthlyMean(await fred(fb)); for (const [k, v] of Object.entries(f)) if (k > last) r[k] = v; }
  rate[c] = r;
}
rate.USD = monthly(await fred(US_RATE));
const days = Object.keys(value.EUR).filter(d => Object.keys(CCY).every(c => value[c][d] !== undefined)).sort();

// rate for a month, carried forward up to 3 months if a value is missing
function rateAt(c, d) { let k = monthOf(d); for (let i = 0; i < 4; i++) { if (rate[c][k] !== undefined) return rate[c][k]; const [y, m] = k.split("-").map(Number); k = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; } return null; }

console.log(`FX TREND AND CARRY: ${SCORE ? "SCORE" : "PLUMBING"}; FRED to ${LAST}`);
let ok = true;
for (const c of Object.keys(CCY)) {
  const ds = Object.keys(value[c]).sort(), rk = Object.keys(rate[c]).sort();
  const scored = days.filter(d => d >= "2010-01-01");
  const missR = scored.filter(d => rateAt(c, d) === null).length;
  if (missR) ok = false;
  console.log(`  ${c}: ${ds.length} days ${ds[0]}..${ds[ds.length - 1]}; rates ${rk[0]}..${rk[rk.length - 1]}; scored days without a rate ${missR}`);
}
const usMiss = days.filter(d => d >= "2010-01-01" && rateAt("USD", d) === null).length;
console.log(`  USD rate ${Object.keys(rate.USD).sort()[0]}..${Object.keys(rate.USD).sort().pop()}; scored days without ${usMiss}`);
const big = []; for (const c of Object.keys(CCY)) for (let i = 1; i < days.length; i++) { const r = value[c][days[i]] / value[c][days[i - 1]] - 1; if (Math.abs(r) > 0.08) big.push(`${c} ${days[i]} ${(100 * r).toFixed(1)}%`); }
console.log(`  common days ${days.length} (${days[0]}..${days[days.length - 1]}); daily moves over 8%: ${big.length ? big.join(", ") : "none"}`);
if (usMiss) ok = false;
console.log(ok ? "PLUMBING: clears" : "PLUMBING FAILS");
if (!SCORE) process.exit(0);
if (!ok) process.exit(1);

// ---- the rules ----
const CS = Object.keys(CCY);
function run({ rule, L = 63, k = 2, cost = 0.0002, markup = 0.005, from, to, only = null }) {
  const out = []; let w = Object.fromEntries(CS.map(c => [c, 0]));
  for (let i = 1; i < days.length; i++) {
    const d0 = days[i - 1], d1 = days[i];
    if (d1 < from || d1 > to) continue;
    // weights decided at d0's close
    let nw = { ...w };
    if (rule === "trend") {
      if (i - 1 - L < 0) continue;
      const back = days[i - 1 - L], set = only ? [only] : CS;
      nw = Object.fromEntries(CS.map(c => [c, 0]));
      for (const c of set) nw[c] = (value[c][d0] > value[c][back] ? 1 : -1) / set.length;
    } else if (rule === "carry") {
      if (out.length === 0 || monthOf(d1) !== monthOf(d0)) {   // the window's first day, or d0 is a month's last close
        const ranked = CS.filter(c => rateAt(c, d0) !== null).sort((a, b) => rateAt(b, d0) - rateAt(a, d0));
        nw = Object.fromEntries(CS.map(c => [c, 0]));
        for (const c of ranked.slice(0, k)) nw[c] = 1 / (2 * k);
        for (const c of ranked.slice(-k)) nw[c] = -1 / (2 * k);
      }
    }
    const dt = (Date.parse(d1) - Date.parse(d0)) / 86400000, us = rateAt("USD", d0);
    let r = 0, turn = 0, gross = 0;
    for (const c of CS) {
      const spot = value[c][d1] / value[c][d0] - 1, rc = rateAt(c, d0);
      const accr = rc === null ? 0 : (rc - us) / 100 * dt / 365;
      r += nw[c] * (spot + accr); turn += Math.abs(nw[c] - w[c]); gross += Math.abs(nw[c]);
    }
    r -= cost * turn + markup * gross * dt / 365;
    out.push([d1, r]); w = nw;
  }
  return out;
}
function stats(rs) {
  const x = rs.map(r => r[1]), n = x.length, m = x.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  let eq = 1, pk = 1, dd = 0; for (const r of x) { eq *= 1 + r; pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1); }
  const yrs = (Date.parse(rs[n - 1][0]) - Date.parse(rs[0][0])) / (365.25 * 86400000);
  return { n, sharpe: m / sd * Math.sqrt(252), ann: eq ** (1 / yrs) - 1, total: eq - 1, dd, vol: sd * Math.sqrt(252) };
}
const fmt = (label, s) => `  ${label.padEnd(40)} Sharpe ${s.sharpe.toFixed(2).padStart(5)}  a year ${(100 * s.ann).toFixed(2).padStart(6)}%  worst drawdown ${(100 * s.dd).toFixed(1).padStart(6)}%  vol ${(100 * s.vol).toFixed(1).padStart(5)}%  leverage for 10% vol ${(0.1 / s.vol).toFixed(1).padStart(4)}x`;
const A = "2010-01-01", MID = "2017-12-31", B = "2018-01-01", Z = LAST;
const blend = (a, b) => { const m = new Map(b); return a.filter(([d]) => m.has(d)).map(([d, r]) => [d, (r + m.get(d)) / 2]); };

for (const rule of ["carry", "trend"]) {
  const P = stats(run({ rule, from: A, to: Z })), H1 = stats(run({ rule, from: A, to: MID })), H2 = stats(run({ rule, from: B, to: Z }));
  console.log(`\nTHE PRIMARY: ${rule === "carry" ? "carry, long the top 2 rates and short the bottom 2 vs USD, monthly" : "trend, each of 7 long or short on its past 63 days, daily"}; 0.02% a trade, 0.5% a year financing markup; ${A}..${Z}`);
  console.log(fmt(`${rule}, 1x gross`, P)); console.log(fmt(`  first half ${A}..${MID}`, H1)); console.log(fmt(`  second half ${B}..${Z}`, H2));
  const t1 = P.sharpe >= 0.5, t2 = H1.total > 0 && H2.total > 0;
  console.log(`VERDICT ${rule}: ${t1 && t2 ? "PASS" : "FAIL"}  (Sharpe ${P.sharpe.toFixed(2)} needs 0.5: ${t1 ? "ok" : "no"}; positive in both halves: ${t2 ? "ok" : "no"})`);
}

console.log("\nREFERENCE ONLY (never a second chance)");
console.log(fmt("carry 1999-2009", stats(run({ rule: "carry", from: "1999-02-01", to: "2009-12-31" }))));
console.log(fmt("trend 1999-2009", stats(run({ rule: "trend", from: "1999-06-01", to: "2009-12-31" }))));
for (const k of [1, 3]) console.log(fmt(`carry top/bottom ${k}`, stats(run({ rule: "carry", k, from: A, to: Z }))));
for (const L of [21, 126, 252]) console.log(fmt(`trend lookback ${L} days`, stats(run({ rule: "trend", L, from: A, to: Z }))));
console.log(fmt("carry, costs doubled", stats(run({ rule: "carry", cost: 0.0004, markup: 0.01, from: A, to: Z }))));
console.log(fmt("trend, costs doubled", stats(run({ rule: "trend", cost: 0.0004, markup: 0.01, from: A, to: Z }))));
console.log(fmt("half carry, half trend", stats(blend(run({ rule: "carry", from: A, to: Z }), run({ rule: "trend", from: A, to: Z })))));
for (const c of CS) console.log(fmt(`trend, ${c} alone`, stats(run({ rule: "trend", only: c, from: A, to: Z }))));
console.log("\nUpper bound: noon fixes as fill prices, interbank rates as financing, a flat broker markup.");
