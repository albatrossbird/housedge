// The sharp-move rule on KXBTC15M back to July: Binance's free BTCUSDT
// trades as the index (lib/binanceTicks.js), Kalshi's public trade tape as
// the book and the fill (lib/tapeBook.js). Needs no key and no Supabase.
//
// Both halves are stand-ins, so this is checked before it is believed:
// run it over October and compare decision by decision with section D of
// source=index (BRTI and the recorded book) for the same days, and with
// the KXBTC15M control of source=altsharp (BRTI and the tape). The first
// says how far the whole substitute strays; the second isolates Binance.
//
// The decision is lib/sharpMove.js's, unchanged. Its book check asks for
// the touch only at an event, so the tape is read only around events:
// [event - 6s, event + 3s], one request on most windows, instead of every
// trade in the final two minutes (~5 pages a Bitcoin window).
//
//   node scripts/m15-binance-sharp.mjs --since=2026-07-01 [--until=2026-11-01]
//        [--size=10] [--cache=.binance-sharp] [--pace=180] [--conc=3] [--list]
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createSharpMove } from "../lib/sharpMove.js";
import { tapeBook } from "../lib/tapeBook.js";
import { parseTrade } from "../lib/m15Tape.js";
import { parseAggTrade, sampleLast } from "../lib/binanceTicks.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SERIES = "KXBTC15M";
const SINCE = Date.parse(`${opt("since", "2026-10-01")}T00:00:00Z`);
const UNTIL = Math.min(opt("until") ? Date.parse(`${opt("until")}T00:00:00Z`) : Infinity, Math.floor((Date.now() - 86400000 * 1.2) / 86400000) * 86400000);
const SIZE = Number(opt("size", 10)), PACE = Number(opt("pace", 180)), CONC = Math.max(1, Number(opt("conc", 3)));
const CACHE = opt("cache", ".binance-sharp"), LIST = process.argv.includes("--list");
const THRESHOLDS = [1, 2, 4], STALE_MS = 5000, DELAY_MS = 250, FILL_WINDOW_MS = 2000, TAIL_MS = 125000;
if (!(SINCE < UNTIL)) { console.error("::error::--since must be before --until (and Binance publishes a day's file the next day)"); process.exit(2); }
mkdirSync(join(CACHE, "ticks"), { recursive: true });

// ---- Kalshi, public ------------------------------------------------------
const B = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 7; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    let r;
    try { r = await fetch(B + path); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 90)} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 90)}: still refused after 7 tries`);
}
const cutoff = await get("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts), tradeCut = Date.parse(cutoff.trades_created_ts);

async function settledWindows() {
  const out = new Map(), keep = m => {
    const close = Date.parse(m.close_time);
    if (close >= SINCE && close < UNTIL && (m.result === "yes" || m.result === "no")) out.set(m.ticker, { ticker: m.ticker, close, result: m.result, day: m.close_time.slice(0, 10) });
    return close;
  };
  if (UNTIL > marketCut) {
    let cursor = "";
    do {
      const d = await get(`/markets?series_ticker=${SERIES}&status=settled&min_close_ts=${Math.floor(Math.max(SINCE, marketCut - 86400000) / 1000)}&max_close_ts=${Math.floor(UNTIL / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      (d.markets || []).forEach(keep); cursor = d.cursor || "";
    } while (cursor);
  }
  if (SINCE < marketCut) {
    let cursor = "", oldest = Infinity;
    do {
      const d = await get(`/historical/markets?series_ticker=${SERIES}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
      for (const m of d.markets || []) oldest = Math.min(oldest, keep(m));
      cursor = d.cursor || "";
    } while (cursor && oldest >= SINCE);
  }
  return [...out.values()].sort((a, b) => a.close - b.close);
}

// ---- Binance, public -----------------------------------------------------
// One day's file -> { closeMs: [[t, v], ...] } for every window closing that
// day, sampled at 5Hz over its final TAIL_MS. Cached; the zip is deleted.
async function dayTicks(day, closes) {
  const file = join(CACHE, "ticks", `${day}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  // Downloaded data goes in its own directory, read only as data.
  const dl = join(CACHE, "dl"); mkdirSync(dl, { recursive: true });
  const zip = join(dl, `BTCUSDT-aggTrades-${day}.zip`);
  const url = `https://data.binance.vision/data/spot/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-${day}.zip`;
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) { writeFileSync(zip, Buffer.from(await r.arrayBuffer())); break; }
    if (i >= 4) throw new Error(`${url} -> ${r.status}`);
    await sleep(2000 * 2 ** i);
  }
  const want = closes.map(c => [c - TAIL_MS - 5000, c]);
  const trades = [];
  const unzip = spawn("unzip", ["-p", zip], { stdio: ["ignore", "pipe", "inherit"] });
  for await (const line of createInterface({ input: unzip.stdout })) {
    const x = parseAggTrade(line);
    if (!x) continue;
    // A window's tail, plus 5s before it so its first sample has a price.
    if (want.some(([a, b]) => x.t >= a && x.t <= b)) trades.push(x);
  }
  rmSync(zip);
  trades.sort((a, b) => a.t - b.t);
  const out = {};
  for (const c of closes) out[c] = sampleLast(trades.filter(x => x.t >= c - TAIL_MS - 5000 && x.t <= c), c - TAIL_MS, c).map(s => [s.t, s.v]);
  writeFileSync(file, JSON.stringify(out));
  return out;
}

// ---- The tape around events, cached per window ----------------------------
const segFile = join(CACHE, "kalshi-segments.json");
const segCache = existsSync(segFile) ? JSON.parse(readFileSync(segFile, "utf8")) : {};
let segWrites = 0;
async function fetchSeg(w, fromMs, toMs) {
  const lo = Math.floor(fromMs / 1000), hi = Math.ceil(toMs / 1000);
  const base = w.close <= tradeCut ? "/historical/trades" : "/markets/trades";
  const rows = []; let cursor = "";
  do {
    const d = await get(`${base}?ticker=${w.ticker}&min_ts=${lo}&max_ts=${hi}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d.trades || []) { const x = parseTrade(raw); if (x) rows.push([x.t, x.side, x.price, x.count]); }
    cursor = d.cursor || "";
  } while (cursor);
  const s = segCache[w.ticker] ||= { ranges: [], trades: [] };
  s.ranges.push([lo * 1000, hi * 1000]);
  const seen = new Set(s.trades.map(r => r.join("|")));
  for (const r of rows) if (!seen.has(r.join("|"))) s.trades.push(r);
  s.trades.sort((a, b) => a[0] - b[0]);
  if (++segWrites % 200 === 0) writeFileSync(segFile, JSON.stringify(segCache));
}

// The rule on one window at one threshold, reading the tape only where the
// decider asks: a touch at an instant the cached tape does not cover stops
// the replay, fetches [t - 6s, t + 3s], and starts it again from the top.
async function decide(w, ticks, thr) {
  for (;;) {
    const s = segCache[w.ticker] || { ranges: [], trades: [] };
    const covered = t => s.ranges.some(([a, b]) => t - 6000 >= a && t + 3000 <= b);
    const book = tapeBook(s.trades.map(([t, side, price, count]) => ({ t, side, price, count })), { staleMs: STALE_MS });
    const dec = createSharpMove(w.close, { thrBp: thr });
    let need = null, res = null;
    for (const [t, v] of ticks) {
      const r = dec.onTick(t, v, at => { if (!covered(at)) { need = at; return null; } return book.at(at); });
      if (need != null) break;
      if (r?.order) { res = r; break; }
    }
    if (need == null) return res ? { r: res, fill: book.fill(res.t, res.order.side, res.order.limit, { delayMs: DELAY_MS, windowMs: FILL_WINDOW_MS }) } : null;
    await fetchSeg(w, need - 6000, need + 3000);
  }
}

// ---- Run -------------------------------------------------------------------
const windows = await settledWindows();
const byDay = new Map();
for (const w of windows) { if (!byDay.has(w.day)) byDay.set(w.day, []); byDay.get(w.day).push(w); }
console.log(`SHARP-MOVE ON KXBTC15M, BINANCE BTCUSDT AS THE INDEX, KALSHI'S TAPE AS THE BOOK — ${new Date(SINCE).toISOString().slice(0, 10)} -> ${new Date(UNTIL).toISOString().slice(0, 10)}, ${windows.length} settled windows, ${SIZE} contracts`);
console.log(`  Index: the last Binance trade sampled every 200ms. Touch: the last print of each side within ${STALE_MS / 1000}s. Fill: the first print of our side ${DELAY_MS}ms-${(DELAY_MS + FILL_WINDOW_MS) / 1000}s later, at or under seen +1c.`);
const rows = [];
let noTicks = 0;
const t0 = Date.now();
for (const [day, ws] of byDay) {
  const ticks = await dayTicks(day, ws.map(w => w.close));
  const queue = [...ws];
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const w = queue.shift(), tk = ticks[w.close] || [];
      if (tk.length < 100) { noTicks++; continue; }
      for (const thr of THRESHOLDS) {
        const d = await decide(w, tk, thr);
        if (!d) continue;
        const { side, seen } = d.r.order, won = side === w.result, f = d.fill;
        const row = { thr, day: w.day, month: w.day.slice(0, 7), ticker: w.ticker, secs: (w.close - d.r.t) / 1000, side, seen, won, filled: f.filled, ctrs: SIZE, result: w.result };
        if (f.filled) {
          const fee = kalshiTakerFee(f.price, SIZE), worseFee = kalshiTakerFee(f.price + 0.01, SIZE);
          Object.assign(row, { price: f.price, pnl: (won ? SIZE : 0) - f.price * SIZE - fee, worse: (won ? SIZE : 0) - (f.price + 0.01) * SIZE - worseFee });
        }
        rows.push(row);
      }
    }
  }));
  console.error(`  ${day}: ${ws.length} windows, ${requests} Kalshi requests so far, ${Math.round((Date.now() - t0) / 1000)}s`);
}
writeFileSync(segFile, JSON.stringify(segCache));

const pct = v => (v == null ? "—" : `${(100 * v).toFixed(1)}%`);
const cents = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`);
const tt = v => (v == null ? "—" : v.toFixed(2));
const line = (label, ys) => {
  if (!ys.length) return `   ${label.padEnd(12)}       0`;
  const fl = ys.filter(r => r.filled === true), ms = ys.filter(r => r.filled === false), un = ys.filter(r => r.filled == null);
  const S = fl.length ? dayStats(fl) : null, W = fl.length ? dayStats(fl.map(r => ({ ...r, pnl: r.worse }))) : null;
  const paid = fl.length ? fl.reduce((a, r) => a + r.price, 0) / fl.length : null;
  return `   ${label.padEnd(12)} ${String(ys.length).padStart(7)} ${String(fl.length).padStart(7)} ${String(ms.length).padStart(6)} ${String(un.length).padStart(7)}  ${pct(fl.length ? fl.filter(r => r.won).length / fl.length : null).padStart(6)} ${pct(ms.length ? ms.filter(r => r.won).length / ms.length : null).padStart(9)}  ${paid == null ? "  —  " : paid.toFixed(3)} ${cents(S?.perCtr).padStart(9)} ${tt(S?.t).padStart(6)}  ${cents(S?.earlyPerCtr).padStart(8)} ${cents(S?.latePerCtr).padStart(8)}  ${cents(W?.perCtr).padStart(8)}`;
};
console.log(`\n${requests} Kalshi requests; ${noTicks} windows with no Binance ticks in their final two minutes`);
console.log("   cut           orders  filled missed unknown  won(f) won(miss)  paid    per ctr t(day)   earlier    later  1c worse");
for (const thr of THRESHOLDS) console.log(line(`${thr}bp`, rows.filter(r => r.thr === thr)));
for (const mo of [...new Set(rows.map(r => r.month))].sort()) console.log(line(`1bp ${mo}`, rows.filter(r => r.thr === 1 && r.month === mo)));
if (LIST) {
  console.log("\n1bp decisions: ticker, seconds out, side, seen, filled at, settled, P&L");
  for (const r of rows.filter(r => r.thr === 1).sort((a, b) => a.ticker.localeCompare(b.ticker)))
    console.log(`   ${r.ticker} ${r.secs.toFixed(1).padStart(6)} ${r.side.padEnd(3)} ${r.seen.toFixed(4)} ${r.filled ? r.price.toFixed(4) : r.filled === false ? "missed" : "unknown"} ${r.result} ${r.filled ? r.pnl.toFixed(4) : ""}`);
}
console.log(`
READING THIS
- Two stand-ins: Binance for BRTI, the tape for the book. Compare October with source=index section D and with
  source=altsharp's KXBTC15M row before reading any earlier month.
- Upper bounds: a print says the ask was at that price, not how much stood there; our ${SIZE} are assumed filled.`);
