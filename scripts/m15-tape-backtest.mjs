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
//
//   --tod [--live=2026-10-19]: p75 split by the decision's hour in New York
//   time, with the trader's 16-20h hypothesis scored on the days before --live
//   (lib/m15TimeOfDay.js).
//
//   --grid [--split=2026-09-01]: the pre-registered grid in lib/m15Tape.js
//   instead — 4 decision points x 6 price bands, one cell chosen on the days
//   before --split by the fixed rule there, and only that cell scored after.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTrade, tapeEntry, tapePnl, GRID_POINTS, GRID_LOOK_MS, GRID_BANDS, GRID_MIN_TRAIN, bandOf, firstBuys, pickCell, candleQuote, packCandle } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";
import { printTimeOfDay } from "../lib/m15TimeOfDay.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SERIES = String(opt("series", "KXBTC15M")).toUpperCase().split(/[,\s]+/).filter(Boolean);
const SINCE = Date.parse(`${opt("since", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))}T00:00:00Z`);
const UNTIL = Math.min(Date.now() - 20 * 60000, opt("until") ? Date.parse(`${opt("until")}T00:00:00Z`) : Infinity);
const SIZE = Number(opt("size", 10)), PACE = Number(opt("pace", 150)), CACHE = opt("cache", ".tape-cache");
// --conc: requests in flight at once (the grid only). PACE stays the gap
// between any two requests, so it still caps the rate.
const CONC = Math.max(1, Number(opt("conc", 1)));
const RULE = { secsMin: 15, secsMax: 45, priceMin: 0.75, priceMax: 0.97 };
const TOD = process.argv.includes("--tod"), LIVE = Date.parse(`${opt("live", "2026-10-19")}T00:00:00Z`);
const GRID = process.argv.includes("--grid"), SPLIT = Date.parse(`${opt("split", "2026-09-01")}T00:00:00Z`);
if (!(SINCE < UNTIL)) { console.error("::error::--since must be before --until"); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 6; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
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

// Every trade in [from, to) of one window, oldest first, as compact rows.
async function tradesBetween(m, from, to) {
  const base = m.close <= tradeCut ? "/historical/trades" : "/markets/trades";
  const out = []; let cursor = "";
  do {
    const d = await get(`${base}?ticker=${m.ticker}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(to / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d.trades || []) { const x = parseTrade(raw); if (x && x.t >= from && x.t < to) out.push(x); }
    cursor = d.cursor || "";
  } while (cursor);
  return out;
}
const pack = x => (x ? [x.t, x.side, x.price, x.count] : null);
const unpack = a => (a ? { t: a[0], side: a[1], price: a[2], count: a[3] } : null);
const fmtSecs = s => (s >= 120 ? `${s / 60}m` : `${s}s`);
const cellLabel = (secs, b) => `${fmtSecs(secs).padStart(3)} ${b.side === "favourite" ? "fav" : "dog"} ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}`;

function statRow(label, ys) {
  if (!ys.length) return `  ${label.padEnd(20)} ${"0".padStart(6)}`;
  const S = dayStats(ys), W = dayStats(ys.map(x => ({ ...x, pnl: x.worse })));
  const won = ys.filter(x => x.won).length / ys.length, paid = ys.reduce((s, x) => s + x.price, 0) / ys.length;
  const needs = ys.reduce((s, x) => s + x.price + kalshiTakerFee(x.price, SIZE) / SIZE, 0) / ys.length;
  return `  ${label.padEnd(20)} ${String(ys.length).padStart(6)}  ${pct(won).padStart(6)}  ${paid.toFixed(3)}  ${pct(needs).padStart(6)}  ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}  ${cents(W.perCtr).padStart(8)} ${tt(W.t).padStart(6)}`;
}

function addEntries(xs, secs, m, entries) {
  for (const e of entries) {
    if (!e) continue;
    const bi = bandOf(e.price);
    if (bi < 0) continue;
    const key = `${secs}|${bi}`;
    if (!xs.has(key)) xs.set(key, []);
    const fee = kalshiTakerFee(e.price, SIZE), worseFee = kalshiTakerFee(e.price + 0.01, SIZE);
    xs.get(key).push({ day: day(m.close), test: m.close >= SPLIT, price: e.price, won: e.side === m.result, ctrs: SIZE,
      pnl: tapePnl(e, m.result, SIZE, fee), worse: tapePnl({ ...e, price: e.price + 0.01 }, m.result, SIZE, worseFee) });
  }
}

// Each window's one-minute candles, cached per series. After Kalshi's
// cutoff, ~24 windows a request; before it, /historical/ one at a time.
async function windowCandles(series, markets) {
  const file = join(CACHE, `${series}-candles.json`);
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const need = markets.filter(m => !cache[m.ticker]);
  const live = need.filter(m => m.close > marketCut), hist = need.filter(m => m.close <= marketCut);
  // Kalshi caps a batch at 10,000 candles counted as markets x minutes
  // spanned (checked 2026-11-02), so a batch is ~24 consecutive windows.
  for (let i = 0; i < live.length;) {
    let j = i + 1;
    while (j < live.length && (j + 1 - i) * ((live[j].close - live[i].close) / 60000 + 18) <= 9500) j++;
    const b = live.slice(i, j); i = j;
    const d = await get(`/markets/candlesticks?market_tickers=${b.map(m => m.ticker).join(",")}&start_ts=${Math.floor(b[0].close / 1000) - 960}&end_ts=${Math.floor(b.at(-1).close / 1000)}&period_interval=1`);
    for (const x of d.markets || []) cache[x.market_ticker ?? x.ticker] = (x.candlesticks || []).map(packCandle);
    // A window the batch did not return is read alone below.
    for (const m of b) if (!cache[m.ticker]) hist.push(m);
  }
  let fetched = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (hist.length) {
      const m = hist.shift(), c = Math.floor(m.close / 1000);
      const q = `candlesticks?start_ts=${c - 960}&end_ts=${c}&period_interval=1`;
      let d;
      try { d = await get(m.close <= marketCut ? `/historical/markets/${m.ticker}/${q}` : `/series/${series}/markets/${m.ticker}/${q}`); }
      catch (e) { if (!/-> 404/.test(e.message)) throw e; d = { candlesticks: [] }; }
      cache[m.ticker] = (d.candlesticks || []).map(packCandle);
      if (++fetched % 500 === 0) { writeFileSync(file, JSON.stringify(cache)); console.error(`  ${series} candles: ${fetched} windows`); }
    }
  }));
  writeFileSync(file, JSON.stringify(cache));
  return cache;
}

// The candles against the trade tape, where both exist: Kalshi's ask at a
// point against the first print of that side in the next 15s. Agreement
// says the candle quote is the price that was there.
function candleCheck(series, markets, candles) {
  for (const secs of GRID_POINTS.filter(s => s >= 60)) {
    const file = join(CACHE, `${series}-g${secs}.json`);
    if (!existsSync(file)) continue;
    const tape = JSON.parse(readFileSync(file, "utf8")), diffs = [];
    for (const m of markets) {
      if (!tape[m.ticker] || !candles[m.ticker]) continue;
      const q = candleQuote(candles[m.ticker], m.close, secs), [y, n] = tape[m.ticker].map(unpack);
      if (q.yes && y) diffs.push(y.price - q.yes.price);
      if (q.no && n) diffs.push(n.price - q.no.price);
    }
    if (!diffs.length) continue;
    const a = diffs.map(Math.abs).sort((x, y) => x - y), med = a[Math.floor(a.length / 2)];
    const within = c => pct(a.filter(x => x <= c + 1e-9).length / a.length);
    const signed = diffs.reduce((s, x) => s + x, 0) / diffs.length;
    console.log(`  CHECK ${series} ${fmtSecs(secs)}: candle price vs the first print of that side within 15s, ${diffs.length} pairs: median |gap| ${cents(med)}, within 1c ${within(0.01)}, within 2c ${within(0.02)}, mean print - candle ${cents(signed)}`);
  }
}

async function runGrid() {
  console.log(`TRADE-TAPE GRID — ${GRID_POINTS.length} decision points x ${GRID_BANDS.length} price bands, ${SIZE} contracts, held to settlement`);
  console.log(`  train ${new Date(SINCE).toISOString().slice(0, 10)} .. ${new Date(SPLIT - 1).toISOString().slice(0, 10)}, test ${new Date(SPLIT).toISOString().slice(0, 10)} -> ${new Date(UNTIL).toISOString().slice(0, 16)} UTC`);
  console.log("  10m/5m/2m: Kalshi's touch then, from its one-minute candles (YES at the ask, NO at 1 - bid).");
  console.log(`  45s: the first taker buy of each side within ${GRID_LOOK_MS / 1000}s (trade tape, as p75). The price picks the band: above 50c the favourite, below the underdog.`);
  console.log(`  Chosen on TRAIN only: highest t(day) among cells with ${GRID_MIN_TRAIN}+ trades. Pass, fixed before the run: TEST t >= 2 AND still positive 1c worse.`);
  console.log("  Upper bound: our whole order assumed filled at that price; nothing about size is known.\n");
  for (const series of SERIES) {
    const t0 = Date.now(), r0 = requests;
    const markets = await settledMarkets(series);
    const p75File = join(CACHE, `${series}.json`), p75 = existsSync(p75File) ? JSON.parse(readFileSync(p75File, "utf8")) : {};
    const xs = new Map(); // cell key -> trades
    const candles = await windowCandles(series, markets);
    candleCheck(series, markets, candles);
    for (const secs of GRID_POINTS) {
      if (secs >= 60) {
        for (const m of markets) addEntries(xs, secs, m, Object.values(candleQuote(candles[m.ticker], m.close, secs)));
        continue;
      }
      const file = join(CACHE, `${series}-g${secs}.json`);
      const cache = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      let fetched = 0;
      const todo = markets.filter(m => !cache[m.ticker]);
      await Promise.all(Array.from({ length: CONC }, async () => {
        while (todo.length) {
          const m = todo.shift(), from = m.close - secs * 1000;
          // The p75 cache already holds every trade 46-14s out: 45s needs no request.
          const trades = secs === 45 && p75[m.ticker] ? p75[m.ticker].map(unpack) : await tradesBetween(m, from, from + GRID_LOOK_MS);
          const f = firstBuys(trades, from);
          cache[m.ticker] = [pack(f.yes), pack(f.no)];
          if (++fetched % 500 === 0) { writeFileSync(file, JSON.stringify(cache)); console.error(`  ${series} ${secs}s: ${fetched} windows`); }
        }
      }));
      for (const m of markets) addEntries(xs, secs, m, cache[m.ticker].map(unpack));
      writeFileSync(file, JSON.stringify(cache));
    }
    const train = markets.filter(m => m.close < SPLIT).length;
    console.log(`${series}: ${markets.length} settled windows (${train} train, ${markets.length - train} test); ${requests - r0} requests, ${Math.round((Date.now() - t0) / 1000)}s`);
    const cells = [];
    for (const secs of GRID_POINTS) GRID_BANDS.forEach((b, bi) => {
      const ys = xs.get(`${secs}|${bi}`) || [];
      const tr = ys.filter(x => !x.test), te = ys.filter(x => x.test);
      cells.push({ key: cellLabel(secs, b), tr, te, train: tr.length ? dayStats(tr) : null });
    });
    const pick = pickCell(cells);
    console.log("  REFERENCE ONLY — every cell, train then test (not a second chance to choose)");
    console.log("  cell                 trades     won   paid   needs   per ctr t(day)   earlier    later  1c worse     t");
    for (const c of cells) { console.log(statRow(`${c.key} trn`, c.tr)); console.log(statRow(`${"".padEnd(c.key.length)} tst`, c.te)); }
    if (!pick) { console.log(`  CHOSEN: none — no cell had ${GRID_MIN_TRAIN}+ train trades\n`); continue; }
    const T = dayStats(pick.te), W = dayStats(pick.te.map(x => ({ ...x, pnl: x.worse })));
    const pass = T.n > 0 && T.t != null && T.t >= 2 && W.perCtr > 0;
    console.log(`  CHOSEN on train: ${pick.key.trim()} (train ${pick.train.n} trades, ${cents(pick.train.perCtr)} a contract, t ${tt(pick.train.t)})`);
    console.log(statRow("  -> TEST", pick.te));
    console.log(`  VERDICT: ${pass ? "PASS" : "FAIL"} (test t ${tt(T.t)}, 1c worse ${cents(W.perCtr)})\n`);
  }
  console.log(`READING THIS
- Only the CHOSEN cell's TEST row is a result. ${GRID_POINTS.length * GRID_BANDS.length} cells were looked at on train; the best of
  them there is expected to look good by luck, which is why it is re-scored on days it never saw.
- With five coins, one PASS in five has roughly a 1-in-10 chance of being luck even so: a pass earns a
  small live test, not a size.`);
}

if (GRID) { await runGrid(); process.exit(0); }

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
    xs.push({ t: e.t, day: day(m.close), month: day(m.close).slice(0, 7), price: e.price, won: e.side === m.result, ctrs: SIZE,
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
  if (TOD) printTimeOfDay({ rows: xs, rule: "p75", liveStart: LIVE, line: row,
    header: "  cut            trades    won   paid   needs         P&L   per ctr t(day)   earlier    later  1c worse" });
  console.log("");
}
console.log(`READING THIS
- "needs" is the win rate that breaks even after the fee. Only per-contract P&L and its t (by day) say anything;
  t under ~2 is noise, and halves that disagree in sign mean it is not a finding.
- Compare KXBTC15M here with the archive backtest's p75 on the same days before reading any other series.`);
