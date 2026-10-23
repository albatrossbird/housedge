// KXBTC15M against BRTI, the index it settles on. Three questions, one
// pass over the WebSocket archive (arithmetic in lib/m15Index.js):
//
//   A. CHECK. Does the settlement average rebuilt from the recorded 5Hz
//      BRTI land on the side Kalshi settled, and does the rebuilt opening
//      average match Kalshi's strike? Everything below leans on this.
//   B. DISTANCE. At 5 min, 2 min and 1 min out, how often does the side
//      the index is ahead on win, by how far ahead it is — and what did
//      Kalshi charge for that side at that moment? A win rate is not an
//      edge; only winning more often than the price plus fee is.
//   C. THE AVERAGE, ESTIMATED. Inside the final minute part of the
//      settlement average is already known. At 45/30/20/10s out, estimate
//      it as the known seconds plus the latest price for the rest: how
//      close does that get, how often is its side right, and does it
//      disagree with Kalshi's favourite often enough to matter?
//   D. TRADE THE MOVE. Buy the side a sharp BRTI move favours (1/2/4bp in
//      one second, book 15-85c, final two minutes, first such move per
//      window), as a limit at the price seen or 1c above, filled against
//      the recorded book 100 or 250ms later, held to settlement.
//
// Upper bounds as everywhere: our orders are not in the replayed book.
// B and C price at the touch with no depth check; D walks the real book.
// Reads only. Needs SUPABASE_SERVICE_ROLE_KEY (the archive is private).
// Usage: node scripts/m15-index.mjs [--days=14 | --since=YYYY-MM-DD] [--size=10,30,200]

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { archiveRow } from "../lib/m15Backtest.js";
import { seriesFees } from "../lib/m15BacktestReport.js";
import { newTape, feedTape, disrupted, bookCursor } from "../lib/m15Maker.js";
import { walkFill } from "../lib/m15Chase.js";
import { kalshiTakerFee, roundKalshiFee } from "../lib/fees.js";
import { atOrBefore } from "../lib/brtiLag.js";
import { createSharpMove } from "../lib/sharpMove.js";
import { settleAvg, estimateAvg, bucketOf, bucketLabel, buyPrice, dayStats } from "../lib/m15Index.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
// --since=YYYY-MM-DD reads from that UTC day on (an out-of-sample re-test);
// otherwise the last --days. Either way no more than 30 days.
const SINCE = opt("since", null);
if (SINCE != null && !/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error(`::error::--since takes YYYY-MM-DD, not ${SINCE}`); process.exit(2); }
const DAYS = Math.min(Number(opt("days", 14)), 30);
const SINCE_MS = Math.max(SINCE != null ? Date.parse(`${SINCE}T00:00:00Z`) : Date.now() - DAYS * 86400000, Date.now() - 30 * 86400000);
const SERIES = "KXBTC15M";
const SIZES = String(opt("size", 10)).split(",").map(Number).filter(n => n > 0);
// --list prints every 1bp decision (+250ms, +1c, the first size), to match
// against a live bot's own log trade by trade.
const LIST = process.argv.includes("--list");
const SIZE = 10;   // B and C price one 10-contract order at the touch
const B_TIMES = [300, 120, 60], B_EDGES = [0, 10, 25, 50, 100];
const C_TIMES = [45, 30, 20, 10], C_EDGES = [0, 5, 10, 25, 50];
const D_THRESHOLDS = [1, 2, 4], D_DELAYS = [100, 250], D_LIMITS = [{ key: "seen", c: 0 }, { key: "+1c", c: 1 }];
const ROW_STALE_MS = 15000;

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const want = new Map();   // ticker -> { close, result, strike, day }
for (const m of await pageAll(rest, "m15_markets", "ticker,close_time,result,strike",
  `series=eq.${SERIES}&result=not.is.null&close_time=gte.${new Date(SINCE_MS).toISOString()}`, { key: "close_time", dedupeOn: "ticker" }))
  if ((m.result === "yes" || m.result === "no") && Number.isFinite(Number(m.strike)) && m.strike !== null)
    want.set(m.ticker, { close: Date.parse(m.close_time), result: m.result, strike: Number(m.strike), day: m.close_time.slice(0, 10) });
const fees = await seriesFees(SERIES);
const MULT = fees?.mult ?? 1;
console.log(`BTC VS ITS INDEX — ${SERIES}, ${want.size} settled windows with a strike since ${new Date(SINCE_MS).toISOString().slice(0, 10)}, fee multiplier ${MULT}${fees ? "" : " (series read failed; assumed)"}`);
const wantClose = new Map([...want].map(([t, m]) => [t, m.close]));

const tape = newTape();
const paths = new Map();   // ticker -> once-a-second rows within 305s of the close
let ticks = [];            // BRTI on CF Benchmarks' clock: { t, v }
const A = { windows: 0, end: 0, agree: 0, ties: 0, start: 0, startDiffs: [] };
const Bs = [], Cs = [], Ds = [], Dlimits = [], Dlist = [];
const excludedD = {};
let watermark = 0;
const done = new Set();
const fee10 = p => kalshiTakerFee(p, SIZE, MULT) / SIZE;
const r2 = x => Math.round(x * 100) / 100;

function finalize(ticker) {
  done.add(ticker);
  const m = want.get(ticker), { close, strike, result, day } = m;
  const tk = ticks.filter(k => k.t >= close - 970000 && k.t <= close + 1000).sort((a, b) => a.t - b.t);
  const path = (paths.get(ticker) || []).sort((a, b) => a.t - b.t);
  paths.delete(ticker);
  const w = tape.win.get(ticker);
  tape.win.delete(ticker);
  A.windows++;

  // A: the rebuilt averages against Kalshi's own numbers.
  const endAvg = settleAvg(tk, close), startAvg = settleAvg(tk, close - 900000);
  if (endAvg != null) {
    A.end++;
    const side = r2(endAvg) >= strike ? "yes" : "no";
    if (side === result) A.agree++;
    if (Math.abs(r2(endAvg) - strike) < 0.005) A.ties++;
  }
  if (startAvg != null) { A.start++; A.startDiffs.push(Math.abs(r2(startAvg) - strike)); }

  const rowAt = t => { const r = atOrBefore(path, t); return r && t - r.t <= ROW_STALE_MS ? r : null; };

  // B: the index's lead over the strike, a few minutes out.
  for (const T of B_TIMES) {
    const now = close - T * 1000, spot = atOrBefore(tk, now), row = rowAt(now);
    if (!spot || now - spot.t > 2000 || !row) continue;
    const d = spot.v - strike, side = d >= 0 ? "yes" : "no", price = buyPrice(row, side);
    if (!(price > 0 && price < 1)) continue;
    Bs.push({ T, d: Math.abs(d), side, price, won: side === result, day, kalshiFav: (row.bid + row.ask) / 2 >= 0.5 ? "yes" : "no" });
  }

  // C: the settlement average, estimated inside the final minute.
  for (const T of C_TIMES) {
    const e = estimateAvg(tk, close, T), row = rowAt(close - T * 1000);
    if (!e || !row) continue;
    const side = e.est >= strike ? "yes" : "no", price = buyPrice(row, side);
    Cs.push({ T, err: endAvg != null ? e.est - endAvg : null, dist: Math.abs(e.est - strike), side, price, valid: price > 0 && price < 1,
      won: side === result, day, kalshiFav: (row.bid + row.ask) / 2 >= 0.5 ? "yes" : "no" });
  }

  // D: buy the side a sharp move favours, against the recorded book.
  const why = w ? disrupted(tape, w) : "no final-window record";
  if (why) { excludedD[why] = (excludedD[why] || 0) + 1; return; }
  for (const thr of D_THRESHOLDS) {
    // The decision is lib/sharpMove.js's, tick by tick, exactly as a live
    // bot would make it; only the fill below is the backtest's.
    const cursor = bookCursor(w, 20);
    const bookAt = t => { const s = cursor.at(t); return s ? { bid: s.bids[0]?.[0], ask: s.asks[0]?.[0] } : null; };
    const dec = createSharpMove(close, { thrBp: thr });
    for (const k of tk) {
      const r = dec.onTick(k.t, k.v, bookAt);
      if (!r?.order) continue;
      const { side, seen, limit } = r.order;
      if (thr === 1) Dlimits.push({ limit, day });
      for (const delay of D_DELAYS) {
        const s2 = cursor.at(r.t + delay);
        for (const l of D_LIMITS) {
          for (const size of SIZES) {
            const f = s2 ? walkFill(s2, side, Math.min(seen + l.c / 100, 0.99), size) : { n: 0, cost: 0, pq: 0 };
            const fee = f.n ? roundKalshiFee(0.07 * MULT * f.pq) : 0;
            Ds.push({ size, thr, delay, limit: l.key, day, n: f.n, won: side === result, cost: f.cost, fee, pnl: (side === result ? f.n : 0) - f.cost - fee, seen, cap: limit });
            if (LIST && thr === 1 && delay === 250 && l.key === "+1c" && size === SIZES[0])
              Dlist.push({ ticker, t: r.t, secs: (close - r.t) / 1000, bp: r.bp, bid: r.bid, ask: r.ask, side, seen, n: f.n, avg: f.n ? f.cost / f.n : null, result, pnl: (side === result ? f.n : 0) - f.cost - fee });
          }
        }
      }
      break;   // one order per window
    }
  }
}

const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 2 * 3600000, Date.now());
const needle = `"m":"${SERIES}-`;
const keep = line => (line.startsWith('{"k":"i5"') && line.includes('"id":"BRTI"'))
  || ((line.startsWith('{"k":"b"') || line.startsWith('{"k":"d"') || line.startsWith('{"k":"full"') || line.startsWith('{"k":"final"')) && line.includes(needle))
  || line.startsWith('{"k":"conn"') || line.startsWith('{"k":"gap"');
const t0 = Date.now();
let bytes = 0, brtiTicks = 0, brtiBackwards = 0, brtiMaxX = -Infinity;
for (const f of files) {
  bytes += f.size || 0;
  await reader.eachLine(f.path, o => {
    if (Number.isFinite(o.t) && o.t > watermark) watermark = o.t;
    if (o.k === "i5") {
      // value_usd is recorded as a string ("108234.56").
      const v = Number(o.v);
      if (!Number.isFinite(o.x) || o.v == null || o.v === "" || !Number.isFinite(v)) return;
      // Recorded in arrival order: a stamp behind the latest already seen is
      // what a live decider would have to refuse.
      if (o.x < brtiMaxX) brtiBackwards++; else brtiMaxX = o.x;
      ticks.push({ t: o.x, v }); brtiTicks++;
      return;
    }
    if (o.k === "b") {
      const m = want.get(o.m);
      if (!m) return;
      const r = archiveRow(o, m.close);
      if (!r || r.secs <= 0 || r.secs > 305) return;
      if (!paths.has(o.m)) paths.set(o.m, []);
      paths.get(o.m).push(r);
      return;
    }
    feedTape(tape, o, wantClose);
  }, keep);
  for (const [ticker, m] of want) if (!done.has(ticker) && m.close + 10000 < watermark) finalize(ticker);
  ticks = ticks.filter(k => k.t >= watermark - 2400000);
}
for (const ticker of want.keys()) if (!done.has(ticker)) finalize(ticker);
if (!brtiTicks) { console.error("::error::no BRTI ticks read from the archive: nothing below would mean anything"); process.exit(1); }
console.log(`archive: ${files.length} hourly files (${(bytes / 1e6).toFixed(0)} MB) in ${Math.round((Date.now() - t0) / 1000)}s, ${brtiTicks.toLocaleString()} BRTI ticks, ${brtiBackwards} arriving behind an earlier stamp`);

const pct = v => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const cents = v => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`);
const tt = v => (v == null ? "—" : v.toFixed(2));
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

console.log("\nA. CHECK — the averages rebuilt from the recorded BRTI against Kalshi's own");
console.log(`   settlement: ${A.end} of ${A.windows} windows rebuilt; the rebuilt close lands on Kalshi's settled side in ${A.agree} (${pct(A.end ? A.agree / A.end : null)}); ${A.ties} within half a cent of the strike`);
console.log(`   strike: ${A.start} rebuilt opening averages; |rebuilt - Kalshi strike| median $${q(A.startDiffs, 0.5)?.toFixed(2) ?? "—"}, p90 $${q(A.startDiffs, 0.9)?.toFixed(2) ?? "—"}, max $${q(A.startDiffs, 1)?.toFixed(2) ?? "—"}`);
console.log("   Under ~99% agreement, or a strike off by more than a few cents, means the rebuild is not Kalshi's average and B-C should be read loosely.");

// One calibration row: won vs priced vs needs, and P&L buying that side at the touch.
function calRow(label, xs) {
  if (!xs.length) return `   ${label.padEnd(16)} ${"0".padStart(5)}`;
  const won = xs.filter(x => x.won).length / xs.length, priced = xs.reduce((s, x) => s + x.price, 0) / xs.length;
  const needs = xs.reduce((s, x) => s + x.price + fee10(x.price), 0) / xs.length;
  const S = dayStats(xs.map(x => ({ day: x.day, ctrs: 1, pnl: (x.won ? 1 : 0) - x.price - fee10(x.price) })));
  const agree = xs.filter(x => x.side === x.kalshiFav).length / xs.length;
  return `   ${label.padEnd(16)} ${String(xs.length).padStart(5)}  ${pct(won).padStart(7)} ${pct(priced).padStart(7)} ${pct(needs).padStart(7)} ${((won - needs) * 100).toFixed(1).padStart(6)}pt ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}  ${pct(agree).padStart(7)}`;
}
const calHead = "   bucket               n      won  priced   needs    edge  per ctr  t(day)   earlier    later  =Kalshi";

console.log("\nB. HOW FAR AHEAD THE INDEX IS, AND HOW OFTEN THAT SIDE WINS");
console.log("   Side = the side BRTI is on against the strike at that moment; |BRTI - strike| in dollars. \"priced\" is Kalshi's");
console.log("   ask for that side then; \"needs\" adds the fee. The side has an edge only if it WON more than \"needs\".");
console.log("   \"=Kalshi\" is how often Kalshi's own favourite was the same side.");
for (const T of B_TIMES) {
  const xs = Bs.filter(x => x.T === T);
  console.log(`\n   ${T >= 60 ? `${T / 60} min` : `${T}s`} before the close`);
  console.log(calHead);
  B_EDGES.forEach((_, i) => console.log(calRow(bucketLabel(B_EDGES, i), xs.filter(x => bucketOf(x.d, B_EDGES) === i))));
  console.log(calRow("all", xs));
}

console.log("\nC. THE SETTLEMENT AVERAGE, ESTIMATED INSIDE THE FINAL MINUTE");
console.log("   Estimate = the seconds of the averaging minute already seen, plus the latest BRTI for every second left.");
console.log("   err = estimate - the rebuilt final average. Buckets are |estimate - strike|; side = the estimate's side.");
for (const T of C_TIMES) {
  const xs = Cs.filter(x => x.T === T), errs = xs.filter(x => x.err != null).map(x => Math.abs(x.err));
  const right = xs.length ? xs.filter(x => x.won).length / xs.length : null;
  console.log(`\n   ${T}s before the close (${60 - T}s of the average known): ${xs.length} windows, |err| median $${q(errs, 0.5)?.toFixed(2) ?? "—"}, p90 $${q(errs, 0.9)?.toFixed(2) ?? "—"}, p99 $${q(errs, 0.99)?.toFixed(2) ?? "—"}; the estimate's side won ${pct(right)}`);
  const vs = xs.filter(x => x.valid);
  console.log(calHead);
  C_EDGES.forEach((_, i) => console.log(calRow(bucketLabel(C_EDGES, i), vs.filter(x => bucketOf(x.dist, C_EDGES) === i))));
  console.log(calRow("all", vs));
  console.log(calRow("disagrees", vs.filter(x => x.side !== x.kalshiFav)));
}
console.log("   \"disagrees\" = windows where the estimate picks the side Kalshi prices as the underdog: the only place an");
console.log("   estimate the market does not already share could pay.");

console.log("\nD. BUY THE SIDE A SHARP BRTI MOVE FAVOURS (final two minutes, first move per window, held to settlement)");
console.log(`   Up to ${SIZES.join(" / ")} contracts a decision (the same decisions at each size), limit at the price seen or 1c above,`);
console.log("   filled against the recorded book after the delay as far as the book held within the limit.");
console.log(`   windows left out of D: ${JSON.stringify(excludedD)}`);
for (const size of SIZES) {
console.log(`\n   ${size} contracts`);
console.log("   move   delay  limit    decided  filled  ctrs  ctrs/asked  won(f)   avg paid      P&L   per ctr  t(day)   earlier    later");
for (const thr of D_THRESHOLDS) for (const delay of D_DELAYS) for (const l of D_LIMITS) {
  const xs = Ds.filter(x => x.size === size && x.thr === thr && x.delay === delay && x.limit === l.key), f = xs.filter(x => x.n > 0);
  const ctrs = f.reduce((s, x) => s + x.n, 0), S = dayStats(xs.map(x => ({ day: x.day, ctrs: x.n, pnl: x.pnl })));
  const won = f.length ? f.filter(x => x.won).length / f.length : null, paid = ctrs ? f.reduce((s, x) => s + x.cost, 0) / ctrs : null;
  console.log(`   ${`${thr}bp`.padEnd(5)} ${`+${delay}ms`.padStart(6)}  ${l.key.padEnd(5)} ${String(xs.length).padStart(8)} ${pct(xs.length ? f.length / xs.length : null).padStart(7)} ${String(ctrs).padStart(5)}  ${pct(xs.length ? ctrs / (xs.length * size) : null).padStart(9)}  ${pct(won).padStart(7)}  ${(paid == null ? "—" : paid.toFixed(3)).padStart(9)}  ${(S.pnl >= 0 ? "+$" : "-$") + Math.abs(S.pnl).toFixed(2).padStart(6)}  ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}`);
}
}

{
  // A risk check refusing limits above 0.97: how many 1bp orders it meets,
  // and what the 10-contract, +250ms, +1c row is without them.
  const over = Dlimits.filter(x => x.limit > 0.97 + 1e-9), lims = Dlimits.map(x => x.limit);
  const xs = Ds.filter(x => x.size === (SIZES.includes(10) ? 10 : SIZES[0]) && x.thr === 1 && x.delay === 250 && x.limit === "+1c");
  const kept = dayStats(xs.filter(x => x.cap <= 0.97 + 1e-9).map(x => ({ day: x.day, ctrs: x.n, pnl: x.pnl })));
  console.log(`\n   1bp orders: ${Dlimits.length}; limit (seen +1c, cap 0.99) median ${q(lims, 0.5)?.toFixed(3) ?? "—"}, p99 ${q(lims, 0.99)?.toFixed(3) ?? "—"}, max ${q(lims, 1)?.toFixed(3) ?? "—"}; above 0.97: ${over.length}`);
  console.log(`   without them (${xs[0]?.size ?? "—"} contracts, +250ms, +1c): ${kept.ctrs} ctrs, ${cents(kept.perCtr)} a contract, t ${tt(kept.t)}`);
}

if (LIST) {
  console.log(`\n   EVERY 1bp DECISION (${SIZES[0]} contracts, +250ms, +1c), CF stamp of the deciding tick`);
  console.log("   ticker                       decided (UTC)             out(s)     bp  book         side  seen  filled  avg     result  P&L");
  for (const x of Dlist.sort((a, b) => a.t - b.t))
    console.log(`   ${x.ticker.padEnd(28)} ${new Date(x.t).toISOString().padEnd(25)} ${x.secs.toFixed(1).padStart(6)} ${x.bp.toFixed(2).padStart(6)}  ${`${x.bid}/${x.ask}`.padEnd(11)}  ${x.side.padEnd(4)}  ${x.seen.toFixed(3)}  ${String(x.n).padStart(6)}  ${x.avg == null ? "  —  " : x.avg.toFixed(3)}  ${x.result.padEnd(6)}  ${(x.pnl >= 0 ? "+" : "") + x.pnl.toFixed(2)}`);
}

console.log(`
READING THIS
- A win rate is a fact about the price, not about skill: a side bought at 0.92 should win about 92%. Only "edge"
  (won minus needs) and P&L per contract say anything, and t(day) under ~2 is noise. Many cells are printed, so one
  of them clearing 2 by luck is expected; earlier/later halves that disagree in sign mean it is not a finding.
- B and C buy at the touch with no depth check and no delay: upper bounds. D fills against the recorded book.`);
