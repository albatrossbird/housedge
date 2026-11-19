// Funding carry on Kalshi's crypto perps (docs/research/perps-carry-plan.md).
//   node scripts/perps-carry.mjs --plumbing   checks only; no funding level is printed
//   node scripts/perps-carry.mjs --score      the bar and the reference rows
// Public reads only: Kalshi's /margin endpoints need no key for market data,
// and Coinbase's exchange candles are public. Everything is cached under
// .perps-cache/ (gitignored) and never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }

const KM = "https://external-api.kalshi.com/trade-api/v2/margin", CB = "https://api.exchange.coinbase.com";
const CACHE = ".perps-cache", END = Date.parse("2026-11-19T00:00:00Z"), HALF = Date.parse("2026-09-01T00:00:00Z");
const COINS = { KXBTCPERP: "BTC-USD", KXETHPERP: "ETH-USD", KXSOLPERP: "SOL-USD" };
const KALSHI_FEE = 0.0012, HEDGE_RT = 0.01, HEDGE_RT_REF = 0.001, N = 10000;
mkdirSync(join(CACHE, "spot"), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let req = 0;
async function getJson(url) {
  for (let i = 0; i < 6; i++) {
    req++; await sleep(150);
    let r;
    try { r = await fetch(url); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${url.slice(0, 120)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${url.slice(0, 120)}: failed after 6 tries`);
}
const cached = f => existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const save = (f, v) => { writeFileSync(f + ".tmp", JSON.stringify(v)); renameSync(f + ".tmp", f); };

// ---- Kalshi: the markets and every funding print ----
const marketsFile = join(CACHE, "markets.json");
const markets = cached(marketsFile) || (await getJson(`${KM}/markets`)).markets;
save(marketsFile, markets);
async function prints(ticker) {
  const f = join(CACHE, `funding-${ticker}.json`), c = cached(f);
  if (c) return c;
  const d = await getJson(`${KM}/funding_rates/historical?ticker=${ticker}`);
  const out = (d.funding_rates || []).filter(x => x.market_ticker === ticker)
    .map(x => ({ t: Date.parse(x.funding_time), rate: Number(x.funding_rate), mark: Number(x.mark_price) }))
    .filter(x => x.t < END).sort((a, b) => a.t - b.t);
  save(f, out);
  return out;
}

// ---- Coinbase: the one-minute close ending at time t ----
async function spotAt(product, t) {
  const f = join(CACHE, "spot", `${product}-${t}.json`), c = cached(f);
  if (c !== undefined) return c;
  const s = new Date(t - 120000).toISOString(), e = new Date(t).toISOString();
  const d = await getJson(`${CB}/products/${product}/candles?granularity=60&start=${s}&end=${e}`);
  // rows are [time, low, high, open, close, volume], newest first; want the minute starting t-60s
  const row = (d || []).find(r => r[0] * 1000 === t - 60000) || (d || [])[0];
  const v = row ? row[4] : null;
  save(f, v);
  return v;
}

const corr = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

// ---- plumbing ----
console.log(`FUNDING CARRY ON KALSHI CRYPTO PERPS: ${SCORE ? "SCORE" : "PLUMBING (no funding level is printed)"}; prints before ${new Date(END).toISOString().slice(0, 10)}`);
console.log("coin         prints  first             gaps>8h  missing%  mark vs spot within 1%  rate~premium corr");
const coin = {};
let ok = true;
for (const [tk, product] of Object.entries(COINS)) {
  const m = markets.find(x => x.ticker === tk);
  if (!m) { console.log(`${tk}: not listed`); ok = false; continue; }
  const cs = Number(m.contract_size), ps = await prints(tk);
  let gaps = 0, missing = 0;
  for (let i = 1; i < ps.length; i++) { const h = (ps[i].t - ps[i - 1].t) / 3600000; if (h > 8.5) { gaps++; missing += Math.round(h / 8) - 1; } }
  const rows = [];
  for (const p of ps) { const s = await spotAt(product, p.t); if (s) rows.push({ ...p, spot: s, prem: p.mark / cs / s - 1 }); }
  const within = rows.filter(r => Math.abs(r.prem) <= 0.01).length / Math.max(ps.length, 1);
  const c = corr(rows.map(r => r.rate), rows.map(r => r.prem));
  const missPct = 100 * missing / (ps.length + missing);
  const okC = ps.length > 0 && missPct < 2 && within >= 0.95 && rows.length === ps.length;
  if (!okC) ok = false;
  coin[tk] = { cs, ps: rows, sign: c >= 0 ? 1 : -1, corr: c };
  console.log(`${tk.padEnd(12)} ${String(ps.length).padStart(6)}  ${new Date(ps[0]?.t || 0).toISOString().slice(0, 16)}  ${String(gaps).padStart(7)}  ${missPct.toFixed(2).padStart(7)}%  ${(100 * within).toFixed(1).padStart(21)}%  ${c.toFixed(3).padStart(8)}${rows.length < ps.length ? `  (spot missing at ${ps.length - rows.length})` : ""}${okC ? "" : "  <- FAILS"}`);
}
console.log(ok ? "PLUMBING: clears" : "PLUMBING FAILS");
if (!SCORE) { console.log(`requests ${req}`); process.exit(0); }
if (!ok) { console.error("refusing to score: plumbing fails"); process.exit(1); }
for (const [tk, c] of Object.entries(coin)) if (c.sign < 0) console.log(`  ${tk}: rate falls with the premium; sign flipped (plan)`);

// ---- the position ----
function carry(c, { hedgeRT = HEDGE_RT, marginFrac = 1 } = {}) {
  const ps = c.ps, a = ps[0], z = ps[ps.length - 1];
  const contracts = N / a.mark, coins = contracts * c.cs;
  let fund = 0, fundH1 = 0, fundH2 = 0;
  for (const p of ps.slice(1)) {   // the entry print's funding is not received: the position opens at it
    const f = c.sign * p.rate * contracts * p.mark;
    fund += f; if (p.t < HALF) fundH1 += f; else fundH2 += f;
  }
  const price = contracts * (a.mark - z.mark) + coins * (z.spot - a.spot);
  const cost = KALSHI_FEE * (N + contracts * z.mark) + hedgeRT / 2 * (N + coins * z.spot);
  const days = (z.t - a.t) / 86400000, capital = N * (1 + marginFrac);
  return { fund, fundH1, fundH2, price, cost, net: fund + price - cost, days, capital, capDays: capital * days };
}
const pool = list => {
  const s = k => list.reduce((x, r) => x + r[k], 0);
  return { fund: s("fund"), fundH1: s("fundH1"), fundH2: s("fundH2"), price: s("price"), cost: s("cost"), net: s("net"), capDays: s("capDays"), days: Math.max(...list.map(r => r.days)) };
};
const ann = r => 100 * r.net / r.capDays * 365;
const line = (label, r) => `  ${label.padEnd(30)} funding ${r.fund.toFixed(0).padStart(6)}  (H1 ${r.fundH1.toFixed(0).padStart(5)}, H2 ${r.fundH2.toFixed(0).padStart(5)})  price ${r.price.toFixed(0).padStart(5)}  costs ${r.cost.toFixed(0).padStart(4)}  net ${r.net.toFixed(0).padStart(6)}  ${ann(r).toFixed(2).padStart(6)}% a year on capital`;

console.log(`\nTHE PRIMARY: short $${N} of each perp, long the same coins in spot, 1x margin, Kalshi 12 bps a side, hedge ${HEDGE_RT * 100}% round trip`);
const per = Object.fromEntries(Object.entries(coin).map(([tk, c]) => [tk, carry(c)]));
const P = pool(Object.values(per));
console.log(line("pooled, BTC + ETH + SOL", P));
const t1 = ann(P) >= 6, t2 = P.fundH1 > 0 && P.fundH2 > 0, t3 = Object.values(per).filter(r => r.fund > 0).length >= 2;
console.log(`VERDICT: ${t1 && t2 && t3 ? "PASS" : "FAIL"}  (net ${ann(P).toFixed(2)}% a year, needs 6%: ${t1 ? "ok" : "no"}; funding positive in both halves: ${t2 ? "ok" : "no"}; funding positive in 2+ of 3 coins: ${t3 ? "ok" : "no"})`);

console.log("\nREFERENCE ONLY (never a second chance)");
for (const [tk, r] of Object.entries(per)) console.log(line(tk, r));
console.log(line("pooled, hedge 0.1% round trip", pool(Object.values(coin).map(c => carry(c, { hedgeRT: HEDGE_RT_REF })))));
console.log(line("pooled, margin N/2", pool(Object.values(coin).map(c => carry(c, { marginFrac: 0.5 })))));

// gross funding, annualized per market: sum of rates over the span, per year
console.log("\n  gross funding to a short, a year (sum of rates / years held; no hedge, no costs)");
const byClass = {};
for (const m of markets) {
  const ps = await prints(m.ticker);
  if (ps.length < 2) continue;
  const yrs = (ps[ps.length - 1].t - ps[0].t) / (365 * 86400000);
  if (yrs < 30 / 365) continue;
  const g = 100 * ps.slice(1).reduce((a, p) => a + p.rate, 0) / yrs;
  (byClass[m.asset_class] ||= []).push({ tk: m.ticker, g, n: ps.length, from: new Date(ps[0].t).toISOString().slice(0, 10) });
}
for (const [cls, rows] of Object.entries(byClass)) {
  const g = rows.map(r => r.g).sort((a, b) => a - b), med = g[Math.floor((g.length - 1) / 2)];
  console.log(`  ${cls.padEnd(10)} ${String(rows.length).padStart(3)} markets  median ${med.toFixed(1).padStart(6)}%  mean ${(g.reduce((a, b) => a + b, 0) / g.length).toFixed(1).padStart(6)}%  range ${g[0].toFixed(1)}..${g[g.length - 1].toFixed(1)}%`);
  if (cls === "Crypto") for (const r of rows.sort((a, b) => b.g - a.g)) console.log(`      ${r.tk.padEnd(14)} ${r.g.toFixed(1).padStart(7)}%  (${r.n} prints from ${r.from})`);
}
console.log(`\nrequests ${req}. Upper bound: funding is what a holder was paid; the fee tier and the hedge cost are assumed, not measured.`);
