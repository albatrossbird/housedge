// A 15-minute rule backtested on Kalshi's public trade tape, for any series
// and any period Kalshi still lists (lib/m15Tape.js explains the method and
// what it cannot see). Needs no key and no Supabase: settled markets and
// trades come straight from Kalshi, the live tier after its cutoff and
// /historical/ before it.
//
// Validate before trusting: run it on KXBTC15M over days the WebSocket
// archive also covers and compare with the archive backtest's same rule.
//
//   node scripts/m15-tape-backtest.mjs --series=KXETH15M,KXSOL15M --since=2026-07-01 [--until=2026-11-01]
//        [--size=10] [--cache=.tape-cache] [--pace=150]
// The default rule is the trader's p75: favourite 15-45s out at 75-97c.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTrade, tapeEntry, tapePnl } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SERIES = String(opt("series", "KXBTC15M")).toUpperCase().split(/[,\s]+/).filter(Boolean);
const SINCE = Date.parse(`${opt("since", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))}T00:00:00Z`);
const UNTIL = Math.min(Date.now() - 20 * 60000, opt("until") ? Date.parse(`${opt("until")}T00:00:00Z`) : Infinity);
const SIZE = Number(opt("size", 10)), PACE = Number(opt("pace", 150)), CACHE = opt("cache", ".tape-cache");
const RULE = { secsMin: 15, secsMax: 45, priceMin: 0.75, priceMax: 0.97 };
if (!(SINCE < UNTIL)) { console.error("::error::--since must be before --until"); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0;
async function get(path) {
  for (let i = 0; i < 6; i++) {
    await sleep(PACE); requests++;
    const r = await fetch(B + path);
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 90)} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 90)}: still refused after 6 tries`);
}

const cutoff = await get("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts), tradeCut = Date.parse(cutoff.trades_created_ts);

// Settled windows of a series closing in [SINCE, UNTIL): the live tier
// filters by close time; the historical tier ignores those filters
// (checked 2026-11-02), so it is paged newest first until past SINCE.
async function settledMarkets(series) {
  const out = new Map(), keep = m => {
    const close = Date.parse(m.close_time);
    if (close >= SINCE && close < UNTIL && (m.result === "yes" || m.result === "no")) out.set(m.ticker, { ticker: m.ticker, close, result: m.result });
    return close;
  };
  if (UNTIL > marketCut) {
    let cursor = "";
    do {
      const d = await get(`/markets?series_ticker=${series}&status=settled&min_close_ts=${Math.floor(Math.max(SINCE, marketCut - 86400000) / 1000)}&max_close_ts=${Math.floor(UNTIL / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      (d.markets || []).forEach(keep); cursor = d.cursor || "";
    } while (cursor);
  }
  if (SINCE < marketCut) {
    let cursor = "", oldest = Infinity;
    do {
      const d = await get(`/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      for (const m of d.markets || []) oldest = Math.min(oldest, keep(m));
      cursor = d.cursor || "";
    } while (cursor && oldest >= SINCE);
  }
  return [...out.values()].sort((a, b) => a.close - b.close);
}

// Every trade in the rule's slice of one window, oldest first.
async function windowTrades(m) {
  const base = m.close <= tradeCut ? "/historical/trades" : "/markets/trades";
  const lo = Math.floor(m.close / 1000) - RULE.secsMax - 1, hi = Math.floor(m.close / 1000) - RULE.secsMin + 1;
  const out = []; let cursor = "";
  do {
    const d = await get(`${base}?ticker=${m.ticker}&min_ts=${lo}&max_ts=${hi}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d.trades || []) { const x = parseTrade(raw); if (x) out.push([x.t, x.side, x.price, x.count]); }
    cursor = d.cursor || "";
  } while (cursor);
  return out.sort((a, b) => a[0] - b[0]);
}

mkdirSync(CACHE, { recursive: true });
const pct = v => (v == null ? "—" : `${(100 * v).toFixed(1)}%`);
const cents = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`);
const tt = v => (v == null ? "—" : v.toFixed(2));
const day = ms => new Date(ms).toISOString().slice(0, 10);

console.log(`TRADE-TAPE BACKTEST — p75 (favourite bought by a taker ${RULE.secsMin}-${RULE.secsMax}s out at ${RULE.priceMin}-${RULE.priceMax}), ${SIZE} contracts, held to settlement`);
console.log(`  ${new Date(SINCE).toISOString().slice(0, 10)} -> ${new Date(UNTIL).toISOString().slice(0, 16)} UTC; Kalshi's historical cutoff: markets ${cutoff.market_settled_ts}, trades ${cutoff.trades_created_ts}`);
console.log("  Upper bound: no spread check, our fill assumed at the printed price, and windows nobody bought in are not decided.\n");

for (const series of SERIES) {
  const t0 = Date.now(), r0 = requests;
  const cacheFile = join(CACHE, `${series}.json`);
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const markets = await settledMarkets(series);
  const xs = [];
  let printedSize = 0;
  let fetched = 0;
  for (const m of markets) {
    if (!cache[m.ticker]) {
      cache[m.ticker] = await windowTrades(m);
      // A pull back to July is hours of requests: keep what is fetched.
      if (++fetched % 500 === 0) { writeFileSync(cacheFile, JSON.stringify(cache)); console.error(`  ${series}: ${fetched} windows fetched`); }
    }
    const trades = cache[m.ticker].map(([t, side, price, count]) => ({ t, side, price, count }));
    const e = tapeEntry(trades, m.close, RULE);
    if (!e) continue;
    if (e.count >= SIZE) printedSize++;
    const fee = kalshiTakerFee(e.price, SIZE), worseFee = kalshiTakerFee(e.price + 0.01, SIZE);
    xs.push({ day: day(m.close), month: day(m.close).slice(0, 7), price: e.price, won: e.side === m.result, ctrs: SIZE,
      pnl: tapePnl(e, m.result, SIZE, fee), worse: tapePnl({ ...e, price: e.price + 0.01 }, m.result, SIZE, worseFee) });
  }
  writeFileSync(cacheFile, JSON.stringify(cache));
  const row = (label, ys) => {
    if (!ys.length) return `  ${label.padEnd(14)} ${"0".padStart(6)}`;
    const S = dayStats(ys), W = dayStats(ys.map(x => ({ ...x, pnl: x.worse })));
    const won = ys.filter(x => x.won).length / ys.length, paid = ys.reduce((s, x) => s + x.price, 0) / ys.length;
    const needs = ys.reduce((s, x) => s + x.price + kalshiTakerFee(x.price, SIZE) / SIZE, 0) / ys.length;
    return `  ${label.padEnd(14)} ${String(ys.length).padStart(6)}  ${pct(won).padStart(6)}  ${paid.toFixed(3)}  ${pct(needs).padStart(6)}  ${(S.pnl >= 0 ? "+$" : "-$") + Math.abs(S.pnl).toFixed(2).padStart(8)}  ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}  ${cents(W.perCtr).padStart(8)}`;
  };
  console.log(`${series}: ${markets.length} settled windows, ${xs.length} decided (${pct(markets.length ? xs.length / markets.length : null)}); the deciding print was ${SIZE}+ contracts in ${pct(xs.length ? printedSize / xs.length : null)}; ${requests - r0} requests, ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("  cut            trades    won   paid   needs         P&L   per ctr t(day)   earlier    later  1c worse");
  console.log(row("all", xs));
  const band = (lo, hi, last) => x => x.price >= lo - 1e-9 && (last ? x.price <= hi + 1e-9 : x.price < hi - 1e-9);
  for (const [lo, hi, last] of [[0.75, 0.85], [0.85, 0.92], [0.92, 0.97, true]]) console.log(row(`${lo.toFixed(2)}-${hi.toFixed(2)}`, xs.filter(band(lo, hi, last))));
  for (const mo of [...new Set(xs.map(x => x.month))].sort()) console.log(row(mo, xs.filter(x => x.month === mo)));
  console.log("");
}
console.log(`READING THIS
- "needs" is the win rate that breaks even after the fee. Only per-contract P&L and its t (by day) say anything;
  t under ~2 is noise, and halves that disagree in sign mean it is not a finding.
- Compare KXBTC15M here with the archive backtest's p75 on the same days before reading any other series.`);
