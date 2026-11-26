// Weather outcomes the observations already confirm (docs/research/wx-confirmed-plan.md).
//   node scripts/wx-confirmed.mjs --plumbing             coverage and the instrument check; no price read
//   node scripts/wx-confirmed.mjs --score --primary-only the verdict (margin 1, delays 0/10/30 from one read)
//   node scripts/wx-confirmed.mjs --score                adds margins 0 and 2
// Public reads only (Kalshi market data, the Iowa Environmental Mesonet's
// ASOS archive), cached under .wx-cache/ (gitignored), never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CLI_TO_STATION, cliFromRules, targetDateOf } from "../lib/weather.js";
import { STATION_TZ } from "../lib/wxBasis.js";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score"), PRIMARY_ONLY = has("primary-only");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }
const KB = "https://api.elections.kalshi.com/trade-api/v2", CACHE = ".wx-cache", SIZE = 10, MIN = 60000;
const WINDOWS = [["A", "2026-02-01", "2026-07-01"], ["B", "2026-07-01", "2026-11-25"]];
const windowOf = d => (WINDOWS.find(([, a, b]) => d >= a && d < b) || [null])[0];
const SINCE = Date.parse(`${WINDOWS[0][1]}T00:00:00Z`), UNTIL = Date.parse(`${WINDOWS[1][2]}T12:00:00Z`);
// local STANDARD time offset, hours east of UTC (the climate day ignores daylight saving)
const STD = { "America/New_York": -5, "America/Chicago": -6, "America/Denver": -7, "America/Phoenix": -7, "America/Los_Angeles": -8 };
for (const d of ["kalshi", "obs", "trades"]) mkdirSync(join(CACHE, d), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let kReq = 0, kRefused = 0, iReq = 0, nextAt = 0;
async function kget(path) {
  for (let i = 0; i < 7; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + 220;
    await sleep(wait); kReq++;
    let r;
    try { r = await fetch(KB + path); } catch { await sleep(1500 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { kRefused++; const ra = Number(r.headers.get("retry-after")); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 7 tries`);
}
const cached = f => existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const save = (f, v) => { writeFileSync(f + ".tmp", JSON.stringify(v)); renameSync(f + ".tmp", f); };

// ---- Kalshi: the US daily-high series and their settled markets ----
const cutoff = await kget("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts), tradeCut = Date.parse(cutoff.trades_created_ts);
async function seriesList() {
  const f = join(CACHE, "kalshi", "series.json"), c = cached(f);
  if (c) return c;
  const d = await kget(`/series?category=${encodeURIComponent("Climate and Weather")}`);
  const out = (d?.series || []).map(s => s.ticker).filter(t => /^KXHIGH/.test(t)).sort();
  save(f, out); return out;
}
async function settled(series) {
  const f = join(CACHE, "kalshi", `${series}.json`), c = cached(f);
  if (c) return c;
  const out = new Map();
  const keep = m => {
    const close = Date.parse(m.close_time);
    if (close >= SINCE && close < UNTIL && (m.result === "yes" || m.result === "no"))
      out.set(m.ticker, { ticker: m.ticker, type: m.strike_type, floor: m.floor_strike, cap: m.cap_strike, result: m.result, date: targetDateOf(m.ticker), cli: cliFromRules(m.rules_primary) });
    return close;
  };
  let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=${series}&status=settled&min_close_ts=${Math.floor(Math.max(SINCE, marketCut - 86400000) / 1000)}&max_close_ts=${Math.floor(UNTIL / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    (d?.markets || []).forEach(keep); cursor = d?.cursor || "";
  } while (cursor);
  let oldest = Infinity; cursor = "";
  do {
    const d = await kget(`/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const m of d?.markets || []) oldest = Math.min(oldest, keep(m));
    cursor = d?.cursor || "";
  } while (cursor && oldest >= SINCE);
  const list = [...out.values()];
  save(f, list); return list;
}

// ---- IEM: a station's routine reports, [utc ms, tmpf] ----
async function observations(icao) {
  const f = join(CACHE, "obs", `${icao}.json`), c = cached(f);
  if (c) return c;
  const st = icao.replace(/^K/, "");
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=${st}&data=tmpf&year1=2026&month1=1&day1=30&year2=2026&month2=11&day2=26&tz=Etc/UTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4`;
  let text = null;
  for (let i = 0; i < 5 && text === null; i++) {
    iReq++;
    try { const r = await fetch(url); if (r.ok) text = await r.text(); else await sleep(3000 * 2 ** i); } catch { await sleep(3000 * 2 ** i); }
  }
  if (text === null) throw new Error(`IEM ${icao}: failed`);
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const [, valid, tmpf] = line.split(",");
    const v = Number(tmpf), t = Date.parse(`${(valid || "").replace(" ", "T")}:00Z`);
    if (Number.isFinite(v) && Number.isFinite(t) && tmpf !== "M") out.push([t, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  save(f, out); return out;
}

// the climate day of a target date at a station: [start, end) in UTC ms
const dayBounds = (date, tz) => { const s = Date.parse(`${date}T00:00:00Z`) - STD[tz] * 3600000; return [s, s + 86400000]; };
// the threshold k (with margin) the running max must reach, and the side it confirms
function confirmRule(m, margin) {
  if (m.type === "greater" && m.floor != null) return { k: m.floor + 1 + margin, side: "yes" };
  if (m.type === "between" && m.cap != null) return { k: m.cap + 1 + margin, side: "no" };
  if (m.type === "less" && m.cap != null) return { k: m.cap + margin, side: "no" };
  return null;
}
function confirmAt(obs, m, margin) {
  const r = confirmRule(m, margin);
  if (!r) return null;
  let max = -Infinity;
  for (const [t, v] of obs) { max = Math.max(max, v); if (Math.round(max) >= r.k) return { t, side: r.side }; }
  return null;
}

// ---- build ----
const t0 = Date.now();
const series = await seriesList();
const markets = [], skipped = {};
const obsByStation = {};
for (const s of series) {
  const ms = await settled(s);
  // historical-tier markets carry no rules text, so a series' station is
  // read from whichever of its markets has it (one station per series)
  const clis = [...new Set(ms.map(m => m.cli).filter(Boolean))];
  if (clis.length > 1) console.error(`  ${s}: more than one station named: ${clis.join(", ")}`);
  for (const m of ms) {
    const icao = CLI_TO_STATION[m.cli || (clis.length === 1 ? clis[0] : null)], tz = STATION_TZ[icao];
    if (!icao || !tz || !windowOf(m.date)) { skipped[s] = (skipped[s] || 0) + 1; continue; }
    obsByStation[icao] ||= await observations(icao);
    const [a, b] = dayBounds(m.date, tz), all = obsByStation[icao];
    let lo = 0, hi = all.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid][0] < a) lo = mid + 1; else hi = mid; }
    const obs = []; for (let i = lo; i < all.length && all[i][0] < b; i++) obs.push(all[i]);
    markets.push({ ...m, series: s, icao, tz, win: windowOf(m.date), obs, hours: new Set(obs.map(([t]) => Math.floor(t / 3600000))).size });
  }
  console.error(`  ${s}: ${ms.length} settled, ${kReq} Kalshi + ${iReq} IEM requests, ${Math.round((Date.now() - t0) / 60000)} min`);
}

// ---- plumbing ----
console.log(`WEATHER CONFIRMED OUTCOMES: ${SCORE ? "SCORE" : "PLUMBING (no price or P&L read)"}; windows ${WINDOWS.map(w => `${w[0]} ${w[1]}..${w[2]}`).join(", ")} (end exclusive)`);
console.log(`US daily-high series used: ${[...new Set(markets.map(m => m.series))].length}; skipped (no US station or outside the windows): ${JSON.stringify(skipped)}`);
const pct = (a, b) => (b ? 100 * a / b : 0).toFixed(2);
const byCity = {};
for (const m of markets) (byCity[m.series] ||= []).push(m);
console.log("series          station  markets  A / B        days with 20+ hours   confirmed (m=1)  against settlement (m=0 / 1 / 2)");
const instr = { 0: [0, 0], 1: [0, 0], 2: [0, 0] };
let covered = 0;
for (const [s, ms] of Object.entries(byCity)) {
  const days = new Map(); for (const m of ms) days.set(m.date, m.hours);
  const okDays = [...days.values()].filter(h => h >= 20).length;
  covered += ms.filter(m => m.hours >= 20).length;
  const per = {};
  for (const margin of [0, 1, 2]) {
    let n = 0, bad = 0;
    for (const m of ms) { if (m.hours < 20) continue; const c = confirmAt(m.obs, m, margin); if (!c) continue; n++; if (c.side !== m.result) bad++; }
    per[margin] = [n, bad]; instr[margin][0] += n; instr[margin][1] += bad;
  }
  console.log(`${s.padEnd(15)} ${ms[0].icao.padEnd(7)} ${String(ms.length).padStart(8)}  ${ms.filter(m => m.win === "A").length} / ${ms.filter(m => m.win === "B").length}`.padEnd(48) + `${pct(okDays, days.size).padStart(6)}%              ${String(per[1][0]).padStart(6)}       ${per[0][1]} / ${per[1][1]} / ${per[2][1]}`);
}
const cov = covered / markets.length;
console.log(`coverage: ${pct(covered, markets.length)}% of markets on days with 20+ observed hours (needs 90%)`);
for (const m of [0, 1, 2]) console.log(`instrument check, margin ${m}: ${instr[m][1]} of ${instr[m][0]} confirmed markets settled against the confirmed side (${pct(instr[m][1], instr[m][0])}%; needs <= 0.50%)`);
let MARGIN = null;
if (cov >= 0.9) MARGIN = instr[1][1] <= 0.005 * instr[1][0] ? 1 : (instr[2][1] <= 0.005 * instr[2][0] ? 2 : null);
console.log(MARGIN === null ? "PLUMBING FAILS: the test stops (plan)" : `PLUMBING: clears with margin ${MARGIN}${MARGIN === 2 ? " (margin 1 failed the instrument check; the plan's fallback)" : ""}`);
if (has("show-misses")) for (const m of markets) { if (m.hours < 20) continue; const c = confirmAt(m.obs, m, MARGIN ?? 1); if (c && c.side !== m.result) console.log(`  miss: ${m.ticker} ${m.type} ${m.floor}/${m.cap} result ${m.result}, max obs ${Math.max(...m.obs.map(o => o[1]))}`); }
if (!SCORE) { console.log(`requests: Kalshi ${kReq}, IEM ${iReq}; ${Math.round((Date.now() - t0) / 60000)} min`); process.exit(0); }
if (MARGIN === null) process.exit(1);

// ---- scoring ----
async function tradesIn(ticker, from, to) {
  const f = join(CACHE, "trades", `${ticker}-${from}-${to}.json`), c = cached(f);
  if (c) return c;
  const base = to <= tradeCut ? "/historical/trades" : "/markets/trades";
  const out = []; let cursor = "";
  do {
    const d = await kget(`${base}?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(to / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d?.trades || []) { const x = parseTrade(raw); if (x && x.t >= from && x.t < to) out.push([x.t, x.side, x.price, x.count]); }
    cursor = d?.cursor || "";
    if (!(d?.trades || []).length) cursor = "";
  } while (cursor);
  save(f, out); return out;
}
const fee = p => kalshiTakerFee(p, SIZE, 1);
function entry(trades, from, side, cap) {
  for (const [t, s, p] of trades) if (t >= from && t < from + 60 * MIN && s === side && p <= cap + 1e-9) return { t, price: p };
  return null;
}
const cells = new Map(), add = (k, v) => { if (!cells.has(k)) cells.set(k, []); cells.get(k).push(v); };
const firstGap = [];
let confirmedN = 0, done = 0;
const margins = PRIMARY_ONLY ? [MARGIN] : [...new Set([MARGIN, 0, 1, 2])];
for (const m of markets) {
  if (++done % 2000 === 0) console.error(`  scored ${done}/${markets.length} markets, ${kReq} Kalshi requests, ${Math.round((Date.now() - t0) / 60000)} min`);
  if (m.hours < 20) continue;
  for (const margin of margins) {
    const c = confirmAt(m.obs, m, margin);
    if (!c) continue;
    const tr = await tradesIn(m.ticker, c.t, c.t + 90 * MIN);
    const mk = (x) => { const won = c.side === m.result; return { day: m.date, win: m.win, price: x.price, won, series: m.series, ctrs: SIZE, pnl: (won ? (1 - x.price) * SIZE : -x.price * SIZE) - fee(x.price) }; };
    if (margin === MARGIN) {
      confirmedN++;
      const e = entry(tr, c.t + 10 * MIN, c.side, 0.97);
      if (e) { add("primary", mk(e)); firstGap.push((e.t - c.t) / MIN); }
      for (const [lab, d] of [["delay 0 min", 0], ["delay 30 min", 30]]) { const x = entry(tr, c.t + d * MIN, c.side, 0.97); if (x) add(lab, mk(x)); }
      for (const cap of [0.95, 0.99]) { const x = entry(tr, c.t + 10 * MIN, c.side, cap); if (x) add(`cap ${Math.round(cap * 100)}c`, mk(x)); }
    }
    if (margin !== MARGIN) { const e = entry(tr, c.t + 10 * MIN, c.side, 0.97); if (e) add(`margin ${margin}`, mk(e)); }
  }
}
const cents = v => `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`;
const tt = t => Number.isFinite(t) ? t.toFixed(2) : "—";
function row(label, ts) {
  if (!ts.length) return `  ${label.padEnd(32)}      0`;
  const S = dayStats(ts), won = ts.filter(x => x.won).length / ts.length, paid = ts.reduce((a, x) => a + x.price, 0) / ts.length;
  return `  ${label.padEnd(32)} ${String(ts.length).padStart(6)}  ${(100 * won).toFixed(2).padStart(6)}%  ${paid.toFixed(3)}  ${cents(S.perCtr).padStart(8)}  t ${tt(S.t).padStart(6)}  days ${String(S.days).padStart(4)}  $${(S.pnl / Math.max(S.days, 1)).toFixed(2).padStart(6)}/day`;
}
const HEAD = "                                   trades     won   paid  per ctr        t        days      at 10 contracts";
const P = cells.get("primary") || [], PA = P.filter(x => x.win === "A"), PB = P.filter(x => x.win === "B");
console.log(`\nTHE PRIMARY: margin ${MARGIN}, first report confirming the market +10 min, first taker print in 60 min buying the confirmed side at <= 97c, 10 contracts, held`);
console.log(HEAD);
console.log(row("A + B (scored)", P)); console.log(row(`A ${WINDOWS[0][1]}..`, PA)); console.log(row(`B ${WINDOWS[1][1]}..`, PB));
console.log(`  (confirmed markets: ${confirmedN}; with no print at <= 97c within 60 min of the decision: ${confirmedN - P.length})`);
const S = dayStats(P), SA = dayStats(PA), SB = dayStats(PB);
const pass = P.length >= 200 && S.perCtr > 0 && S.t >= 2 && SA.perCtr > 0 && SB.perCtr > 0;
console.log(`VERDICT: ${pass ? "PASS" : "FAIL"}  (needs per ctr > 0 at t >= 2 pooled, positive in A and in B, 200+ trades: ${cents(S.perCtr)} t ${tt(S.t)}; A ${cents(SA.perCtr)}; B ${cents(SB.perCtr)}; ${P.length} trades)`);
console.log("\nREFERENCE ONLY (never a second chance)");
console.log(HEAD);
for (const [k, v] of cells) if (k !== "primary") console.log(row(k, v));
const bySeries = {}; for (const x of P) (bySeries[x.series] ||= []).push(x);
for (const [s, v] of Object.entries(bySeries).sort()) console.log(row(s, v));
const g = [...firstGap].sort((a, b) => a - b);
if (g.length) console.log(`  minutes from confirming report to the entry print: p10 ${g[Math.floor(0.1 * (g.length - 1))].toFixed(0)}, median ${g[Math.floor(0.5 * (g.length - 1))].toFixed(0)}, p90 ${g[Math.floor(0.9 * (g.length - 1))].toFixed(0)}`);
console.log(`\nrequests: Kalshi ${kReq} (${kRefused} refused), IEM ${iReq}; ${Math.round((Date.now() - t0) / 60000)} min. Upper bound: a print says someone traded there, not that 10 more were available.`);
