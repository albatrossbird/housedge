// The sharp-move entry on the ALTCOIN 15-minute series, each against its
// own CF Benchmarks index (workflow 'Backtest 15-minute strategies',
// source: altsharp). KXBTC15M is run beside them as the control.
//
// The decision is lib/sharpMove.js's, tick by tick, exactly as on Bitcoin,
// fed each coin's 5Hz index from the m15/ archive (recorded all day for
// BTC/ETH/SOL/XRP/DOGE). The altcoin BOOKS were not recorded before m15c/
// (2026-10-29), so the touch the decider checks, and the fill, come from
// Kalshi's public trade tape instead (lib/tapeBook.js). That swap is the
// thing to distrust, so KXBTC15M runs through the SAME tape path here:
// compare its row with section D of source=index (the recorded book) over
// the same days before reading any altcoin row.
//
// Fixed before the run: 1bp is the rule as traded on Bitcoin and the only
// row that is a result; 2bp and 4bp are printed for reference. A basis
// point is not the same size of move on every coin, which is why this is
// a test of THE rule, not a search for a better one.
//
// Index ids are not assumed: every 5Hz id containing the coin's symbol is
// tried, and the one whose rebuilt settlement average lands on Kalshi's
// settled side most often is used. Its agreement is printed (section A);
// below ~99% nothing after it means anything.
//
//   node scripts/m15-alt-sharp.mjs --since=YYYY-MM-DD [--until=YYYY-MM-DD]
//        [--series=KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M,KXDOGE15M] [--size=10] [--conc=4]
import { archiveReader } from "../lib/archiveRead.js";
import { createSharpMove } from "../lib/sharpMove.js";
import { settleAvg, dayStats } from "../lib/m15Index.js";
import { tapeBook } from "../lib/tapeBook.js";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { seriesFees } from "../lib/m15BacktestReport.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SINCE = opt("since", null), UNTIL = opt("until", null);
for (const [k, v] of [["since", SINCE], ["until", UNTIL]]) if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`::error::--${k} takes YYYY-MM-DD`); process.exit(2); }
// No more than 30 days: the index is read from Storage, and egress costs.
const SINCE_MS = Math.max(SINCE ? Date.parse(`${SINCE}T00:00:00Z`) : Date.now() - 14 * 86400000, Date.now() - 31 * 86400000);
const UNTIL_MS = Math.min(UNTIL ? Date.parse(`${UNTIL}T00:00:00Z`) : Infinity, Date.now() - 20 * 60000);
if (!(UNTIL_MS > SINCE_MS)) { console.error("::error::--until must be after the start"); process.exit(2); }
const SERIES = String(opt("series", "KXBTC15M,KXETH15M,KXSOL15M,KXXRP15M,KXDOGE15M")).toUpperCase().split(/[,\s]+/).filter(Boolean);
const SIZE = Number(opt("size", 10)), CONC = Number(opt("conc", 4)), PACE = Number(opt("pace", 100));
const THRESHOLDS = [1, 2, 4], STALE_MS = 5000, DELAY_MS = 250, FILL_WINDOW_MS = 2000;
const symbolOf = s => s.replace(/^KX/, "").replace(/15M$/, "");

// ---- Kalshi, public ------------------------------------------------------
const B = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, nextAt = 0;
async function kget(path) {
  for (let i = 0; i < 7; i++) {
    // One shared pace across the workers: Kalshi rate-limits datacenter IPs.
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    let r;
    try { r = await fetch(B + path); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(Number(r.headers.get("retry-after")) * 1000 || 1500 * 2 ** i); continue; }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 90)} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 90)}: still refused after 7 tries`);
}
const cutoff = await kget("/historical/cutoff");
const tradeCut = Date.parse(cutoff.trades_created_ts);

async function settled(series) {
  const out = [];
  let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=${series}&status=settled&min_close_ts=${Math.floor(SINCE_MS / 1000)}&max_close_ts=${Math.floor(UNTIL_MS / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const m of d.markets || []) {
      const close = Date.parse(m.close_time), strike = Number(m.floor_strike);
      if (close >= SINCE_MS && close < UNTIL_MS && (m.result === "yes" || m.result === "no") && m.floor_strike != null && Number.isFinite(strike))
        out.push({ series, ticker: m.ticker, close, strike, result: m.result, day: m.close_time.slice(0, 10) });
    }
    cursor = d.cursor || "";
  } while (cursor);
  return out.sort((a, b) => a.close - b.close);
}
async function finalTrades(m) {
  const base = m.close <= tradeCut ? "/historical/trades" : "/markets/trades";
  const from = m.close - 130000, to = m.close;
  const out = []; let cursor = "";
  do {
    const d = await kget(`${base}?ticker=${m.ticker}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(to / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d.trades || []) { const x = parseTrade(raw); if (x && x.t >= from && x.t < to) out.push(x); }
    cursor = d.cursor || "";
  } while (cursor);
  return out.sort((a, b) => a.t - b.t);
}

const windows = [];
const mult = {};
for (const s of SERIES) { windows.push(...await settled(s)); mult[s] = (await seriesFees(s))?.mult ?? 1; }
console.log(`SHARP-MOVE ON EACH COIN'S OWN INDEX — ${SERIES.join(", ")}, ${new Date(SINCE_MS).toISOString().slice(0, 10)} -> ${new Date(UNTIL_MS).toISOString().slice(0, 16)} UTC, ${SIZE} contracts`);
console.log(`  ${windows.length} settled windows; fee multipliers ${SERIES.map(s => `${symbolOf(s)} ${mult[s]}`).join(", ")}`);
console.log(`  Touch and fill from Kalshi's trade tape: last print of each side within ${STALE_MS / 1000}s; filled if the first print of our side ${DELAY_MS}ms-${(DELAY_MS + FILL_WINDOW_MS) / 1000}s after the event is at or under seen +1c.`);

// ---- The index, from the archive -----------------------------------------
// Only ticks inside the final 125s of some window are kept: windows close
// on the quarter hour, so that is a test on the clock, not a lookup.
const inTail = t => { const r = ((900000 - (t % 900000)) % 900000); return r <= 125000; };
const symbols = SERIES.map(symbolOf);
const ticksById = new Map(), idCounts = new Map();
const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 3600000, Math.min(UNTIL_MS + 3600000, Date.now()));
const t0 = Date.now();
let bytes = 0;
for (const f of files) {
  bytes += f.size || 0;
  await reader.eachLine(f.path, o => {
    if (o.k !== "i5" || !Number.isFinite(o.x)) return;
    idCounts.set(o.id, (idCounts.get(o.id) || 0) + 1);
    const v = Number(o.v);
    if (o.v == null || o.v === "" || !Number.isFinite(v) || !inTail(o.x)) return;
    if (o.id !== "BRTI" && !symbols.some(s => String(o.id).toUpperCase().includes(s))) return;
    if (!ticksById.has(o.id)) ticksById.set(o.id, []);
    ticksById.get(o.id).push({ t: o.x, v });
  }, line => line.startsWith('{"k":"i5"'));
}
for (const a of ticksById.values()) a.sort((x, y) => x.t - y.t);
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB) in ${Math.round((Date.now() - t0) / 1000)}s; 5Hz ids seen: ${[...idCounts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n.toLocaleString()}`).join(", ")}`);

const slice = (arr, lo, hi) => {
  let a = 0, b = arr.length;
  while (a < b) { const m = (a + b) >> 1; if (arr[m].t < lo) a = m + 1; else b = m; }
  const out = [];
  for (let i = a; i < arr.length && arr[i].t <= hi; i++) out.push(arr[i]);
  return out;
};

// A. Which id each series settles on, and how well it is rebuilt.
console.log("\nA. CHECK — each candidate index's rebuilt settlement average against the side Kalshi settled");
const idFor = {};
for (const s of SERIES) {
  const sym = symbolOf(s), ws = windows.filter(w => w.series === s);
  const cands = [...ticksById.keys()].filter(id => (sym === "BTC" ? id === "BRTI" : String(id).toUpperCase().includes(sym)));
  let best = null;
  for (const id of cands) {
    let n = 0, agree = 0;
    for (const w of ws) {
      const avg = settleAvg(slice(ticksById.get(id), w.close - 65000, w.close + 1000), w.close);
      if (avg == null) continue;
      n++; if ((Math.round(avg * 1e6) / 1e6 >= w.strike ? "yes" : "no") === w.result) agree++;
    }
    console.log(`  ${s.padEnd(10)} ${String(id).padEnd(16)} ${n} windows rebuilt, ${agree} on Kalshi's side (${n ? (100 * agree / n).toFixed(1) : "—"}%)`);
    if (n && (!best || agree / n > best.rate)) best = { id, rate: agree / n, n };
  }
  idFor[s] = best;
  if (!best) console.log(`  ${s}: no index found — skipped`);
  else if (best.rate < 0.99) console.log(`::warning::${s}: the best index (${best.id}) agrees with Kalshi on only ${(100 * best.rate).toFixed(1)}% — read nothing below for it`);
}

// ---- Decide each window --------------------------------------------------
const rows = [];   // one per window x threshold that sent an order
const skips = {};
let tapeTrades = 0, done = 0;
async function decideWindow(w) {
  const pick = idFor[w.series];
  if (!pick) return;
  const tk = slice(ticksById.get(pick.id), w.close - 125000, w.close);
  if (tk.length < 100) { skips[`${w.series} index missing`] = (skips[`${w.series} index missing`] || 0) + 1; return; }
  const trades = await finalTrades(w);
  tapeTrades += trades.length;
  const book = tapeBook(trades, { staleMs: STALE_MS });
  for (const thr of THRESHOLDS) {
    const dec = createSharpMove(w.close, { thrBp: thr });
    let order = null;
    for (const k of tk) {
      const r = dec.onTick(k.t, k.v, t => book.at(t));
      if (r?.skip && thr === 1) { const key = `${w.series} ${r.skip}`; skips[key] = (skips[key] || 0) + 1; }
      if (r?.order) { order = r; break; }
    }
    if (!order) continue;
    const { side, seen, limit } = order.order;
    const f = book.fill(order.t, side, limit, { delayMs: DELAY_MS, windowMs: FILL_WINDOW_MS });
    const won = side === w.result, m = mult[w.series];
    const row = { series: w.series, thr, day: w.day, won, side, seen, filled: f.filled, ctrs: SIZE, secs: (w.close - order.t) / 1000, mid: order.mid };
    if (f.filled) {
      const fee = kalshiTakerFee(f.price, SIZE, m), worseFee = kalshiTakerFee(f.price + 0.01, SIZE, m);
      Object.assign(row, { price: f.price, printed: f.count, pnl: (won ? SIZE : 0) - f.price * SIZE - fee, worse: (won ? SIZE : 0) - (f.price + 0.01) * SIZE - worseFee });
    }
    rows.push(row);
  }
}
const queue = [...windows];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const w = queue.shift();
    await decideWindow(w);
    if (++done % 1000 === 0) console.error(`  ${done}/${windows.length} windows, ${requests} requests`);
  }
}));
console.log(`\ntape: ${tapeTrades.toLocaleString()} trades read in ${requests} requests`);

// ---- Report --------------------------------------------------------------
const pct = v => (v == null ? "—" : `${(100 * v).toFixed(1)}%`);
const cents = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`);
const tt = v => (v == null ? "—" : v.toFixed(2));
console.log("\nD. BUY THE SIDE A SHARP INDEX MOVE FAVOURS — final two minutes, first move per window, held to settlement");
console.log("   1bp is the rule as traded on Bitcoin and the only result; 2bp and 4bp are reference. unknown = no print of our side in the fill window.");
console.log("   series     thr  orders  filled missed unknown  won(f) won(miss)  paid    per ctr t(day)   earlier    later  1c worse");
for (const s of SERIES) for (const thr of THRESHOLDS) {
  const ys = rows.filter(r => r.series === s && r.thr === thr);
  if (!ys.length) { console.log(`   ${s.padEnd(10)} ${String(thr).padStart(2)}bp       0`); continue; }
  const fl = ys.filter(r => r.filled === true), ms = ys.filter(r => r.filled === false), un = ys.filter(r => r.filled == null);
  const S = fl.length ? dayStats(fl) : null, W = fl.length ? dayStats(fl.map(r => ({ ...r, pnl: r.worse }))) : null;
  const paid = fl.length ? fl.reduce((a, r) => a + r.price, 0) / fl.length : null;
  console.log(`   ${s.padEnd(10)} ${String(thr).padStart(2)}bp ${String(ys.length).padStart(7)} ${String(fl.length).padStart(7)} ${String(ms.length).padStart(6)} ${String(un.length).padStart(7)}  ${pct(fl.length ? fl.filter(r => r.won).length / fl.length : null).padStart(6)} ${pct(ms.length ? ms.filter(r => r.won).length / ms.length : null).padStart(9)}  ${paid == null ? "  —  " : paid.toFixed(3)} ${cents(S?.perCtr).padStart(9)} ${tt(S?.t).padStart(6)}  ${cents(S?.earlyPerCtr).padStart(8)} ${cents(S?.latePerCtr).padStart(8)}  ${cents(W?.perCtr).padStart(8)}`);
}
console.log("\n   Passed over at 1bp (an event the rule did not trade; a later one may have):");
for (const [k, n] of Object.entries(skips).sort()) console.log(`     ${k}: ${n}`);
console.log(`
READING THIS
- KXBTC15M here is the CONTROL: the same rule through the same tape proxy. Compare it with section D of
  source=index over the same days (the recorded book). If they disagree, no altcoin row means anything.
- Upper bounds: a print says the ask was at that price, not how much stood there; our ${SIZE} are assumed filled.
- t under ~2 is noise, and halves that disagree in sign mean it is not a finding.`);
