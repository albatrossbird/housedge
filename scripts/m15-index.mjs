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
//   D3. MANAGE IT. The live configuration of D, but at 15s out the
//      position is sold if our side has become the underdog (bid <= 0.30)
//      or added to if it is the favourite (ask >= 0.75): lib/sharpManage.js.
//
// Upper bounds as everywhere: our orders are not in the replayed book.
// B and C price at the touch with no depth check; D walks the real book.
// Reads only. Needs SUPABASE_SERVICE_ROLE_KEY (the archive is private).
// Usage: node scripts/m15-index.mjs [--days=14 | --since=YYYY-MM-DD [--until=YYYY-MM-DD]] [--size=10,30,200]

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
import { MANAGE_SECS, MANAGE_DELAY_MS, decideManage, fillManage, managedPnl } from "../lib/sharpManage.js";
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
// --until=YYYY-MM-DD stops before that UTC day: a period that ended can be
// read again on its own, without the days since mixed in.
const UNTIL = opt("until", null);
if (UNTIL != null && !/^\d{4}-\d{2}-\d{2}$/.test(UNTIL)) { console.error(`::error::--until takes YYYY-MM-DD, not ${UNTIL}`); process.exit(2); }
const UNTIL_MS = UNTIL != null ? Date.parse(`${UNTIL}T00:00:00Z`) : Date.now();
if (!(UNTIL_MS > SINCE_MS)) { console.error(`::error::--until must be after the start (${new Date(SINCE_MS).toISOString().slice(0, 10)})`); process.exit(2); }
const SERIES = "KXBTC15M";
const SIZES = String(opt("size", 10)).split(",").map(Number).filter(n => n > 0);
// --list prints every 1bp decision (+250ms, +1c, the first size), to match
// against a live bot's own log trade by trade.
const LIST = process.argv.includes("--list");
const SIZE = 10;   // B and C price one 10-contract order at the touch
const B_TIMES = [300, 120, 60], B_EDGES = [0, 10, 25, 50, 100];
const C_TIMES = [45, 30, 20, 10], C_EDGES = [0, 5, 10, 25, 50];
const D_THRESHOLDS = [1, 2, 4], D_DELAYS = [100, 250], D_LIMITS = [{ key: "seen", c: 0 }, { key: "+1c", c: 1 }];
// D2's narrower mid bands, each run as its own decider (a narrower band
// skips an event and may act on a later one in the same window).
const D_BANDS = [[0.20, 0.80], [0.25, 0.75], [0.30, 0.70], [0.35, 0.65]];
const ROW_STALE_MS = 15000;

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const want = new Map();   // ticker -> { close, result, strike, day }
for (const m of await pageAll(rest, "m15_markets", "ticker,close_time,result,strike",
  `series=eq.${SERIES}&result=not.is.null&close_time=gte.${new Date(SINCE_MS).toISOString()}&close_time=lt.${new Date(UNTIL_MS).toISOString()}`, { key: "close_time", dedupeOn: "ticker" }))
  if ((m.result === "yes" || m.result === "no") && Number.isFinite(Number(m.strike)) && m.strike !== null)
    want.set(m.ticker, { close: Date.parse(m.close_time), result: m.result, strike: Number(m.strike), day: m.close_time.slice(0, 10) });
const fees = await seriesFees(SERIES);
const MULT = fees?.mult ?? 1;
console.log(`BTC VS ITS INDEX — ${SERIES}, ${want.size} settled windows with a strike since ${new Date(SINCE_MS).toISOString().slice(0, 10)}${UNTIL ? ` until ${UNTIL} (exclusive)` : ""}, fee multiplier ${MULT}${fees ? "" : " (series read failed; assumed)"}`);
const wantClose = new Map([...want].map(([t, m]) => [t, m.close]));

const tape = newTape();
const paths = new Map();   // ticker -> once-a-second rows within 305s of the close
let ticks = [];            // BRTI on CF Benchmarks' clock: { t, v }
const A = { windows: 0, end: 0, agree: 0, ties: 0, start: 0, startDiffs: [] };
const Bs = [], Cs = [], Ds = [], Dlimits = [], Dlist = [], Dband = [], Dmanage = [];
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
            Ds.push({ size, thr, delay, limit: l.key, day, n: f.n, won: side === result, cost: f.cost, fee, pnl: (side === result ? f.n : 0) - f.cost - fee, seen, cap: limit, mid: r.mid });
            if (thr === 1 && delay === 250 && l.key === "+1c" && size === SIZES[0] && f.n > 0) {
              // D3: the same filled position, managed at 15s out. Its own
              // cursor: the D cursor has moved past this decision's fill.
              const pos = { side, won: side === result, n: f.n, cost: f.cost, fee };
              const at = close - MANAGE_SECS * 1000;
              let d = null, s3 = null;
              if (r.t + delay < at) { const c3 = bookCursor(w, 20); d = decideManage(c3.at(at), side); s3 = c3.at(at + MANAGE_DELAY_MS); }
              const fill = worse => fillManage(s3, side, d, f.n, { addQty: SIZES[0], mult: MULT, worse });
              const m = fill(0), mw = fill(0.01), base = managedPnl(pos, null);
              Dmanage.push({ day, n: f.n, won: pos.won, act: d ? d.action : (r.t + delay < at ? "no book" : "too late"), quote: d, k: m.k, base,
                sell: d?.action === "sell" ? managedPnl(pos, m) : base, add: d?.action === "add" ? managedPnl(pos, m) : base,
                both: managedPnl(pos, m), bothWorse: managedPnl(pos, mw) });
            }
            if (LIST && thr === 1 && delay === 250 && l.key === "+1c" && size === SIZES[0])
              Dlist.push({ ticker, t: r.t, secs: (close - r.t) / 1000, bp: r.bp, bid: r.bid, ask: r.ask, side, seen, n: f.n, avg: f.n ? f.cost / f.n : null, result, pnl: (side === result ? f.n : 0) - f.cost - fee });
          }
        }
      }
      break;   // one order per window
    }
  }
  // D2: 1bp with each narrower mid band, as live: +250ms, seen +1c, first size.
  for (const [midLo, midHi] of D_BANDS) {
    const cursor = bookCursor(w, 20);
    const bookAt = t => { const s = cursor.at(t); return s ? { bid: s.bids[0]?.[0], ask: s.asks[0]?.[0] } : null; };
    const dec = createSharpMove(close, { thrBp: 1, midLo, midHi });
    for (const k of tk) {
      const r = dec.onTick(k.t, k.v, bookAt);
      if (!r?.order) continue;
      const { side, seen } = r.order, s2 = cursor.at(r.t + 250);
      const f = s2 ? walkFill(s2, side, Math.min(seen + 0.01, 0.99), SIZES[0]) : { n: 0, cost: 0, pq: 0 };
      const fee = f.n ? roundKalshiFee(0.07 * MULT * f.pq) : 0;
      Dband.push({ band: `${midLo.toFixed(2)}-${midHi.toFixed(2)}`, day, n: f.n, won: side === result, cost: f.cost, pnl: (side === result ? f.n : 0) - f.cost - fee });
      break;
    }
  }
}

const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 2 * 3600000, Math.min(UNTIL_MS + 2 * 3600000, Date.now()));
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

{
  // D2. The same 1bp decisions split by price: the price SEEN for the side
  // bought (YES ask, or 1 - YES bid), which a bot knows before it sends and
  // the price paid is within a cent of, and by the mid band the decider
  // tests (0.15-0.85 as it stands). Every row is a cut chosen on this data
  // or on the live days, so read it with the halves and the out-of-sample
  // run beside it: one cell in a dozen clearing t 2 is what luck does.
  const size = SIZES.includes(10) ? 10 : SIZES[0];
  const xs = Ds.filter(x => x.size === size && x.thr === 1 && x.delay === 250 && x.limit === "+1c");
  const nDays = new Set([...want.values()].map(m => m.day)).size || 1;
  const row = (label, ys) => {
    const f = ys.filter(x => x.n > 0), ctrs = f.reduce((a, x) => a + x.n, 0), S = dayStats(ys.map(x => ({ day: x.day, ctrs: x.n, pnl: x.pnl })));
    const won = f.length ? f.filter(x => x.won).length / f.length : null, paid = ctrs ? f.reduce((a, x) => a + x.cost, 0) / ctrs : null;
    return `   ${label.padEnd(18)} ${String(ys.length).padStart(5)} ${(ys.length / nDays).toFixed(1).padStart(6)} ${String(f.length).padStart(6)}  ${pct(won).padStart(7)}  ${(paid == null ? "—" : paid.toFixed(3)).padStart(7)}  ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}`;
  };
  const head = "   cut                decided  /day  filled   won(f)  avg paid   per ctr  t(day)   earlier    later";
  console.log(`\nD2. 1bp DECISIONS BY PRICE (${size} contracts, +250ms, limit seen +1c; ${nDays} days)`);
  console.log("   By the price SEEN for the side bought (paid is within 1c of it):");
  console.log(head);
  const band = (lo, hi) => x => x.seen > lo + 1e-9 && x.seen <= hi + 1e-9;
  console.log(row("<= 0.30", xs.filter(x => x.seen <= 0.30 + 1e-9)));
  console.log(row("0.30-0.60", xs.filter(band(0.30, 0.60))));
  console.log(row("> 0.60", xs.filter(x => x.seen > 0.60 + 1e-9)));
  for (let lo = 0.1; lo < 0.9 - 1e-9; lo += 0.1) console.log(row(`${lo.toFixed(1)}-${(lo + 0.1).toFixed(1)}`, xs.filter(band(lo, lo + 0.1))));
  console.log(row("all", xs));
  console.log("   By the mid band the decider tests, narrowed symmetrically (0.15-0.85 is the rule as it stands):");
  console.log(head);
  console.log(row("mid 0.15-0.85", xs));
  for (const [lo, hi] of D_BANDS) { const k = `${lo.toFixed(2)}-${hi.toFixed(2)}`; console.log(row(`mid ${k}`, Dband.filter(x => x.band === k))); }
  console.log("   Each narrower band is its own decider run: an out-of-band event is skipped and a later in-band one in the same");
  console.log("   window may be taken, as the live bot would. The price-seen rows above filter the 0.15-0.85 decisions instead.");
}

{
  // D3. The live configuration's filled positions, managed at 15s out.
  // Per contract is per contract of the ORIGINAL position, so the rows
  // compare the same positions; an add risks more for the same count.
  const size = SIZES[0], xs = Dmanage;
  console.log(`\nD3. MANAGE THE POSITION AT ${MANAGE_SECS}s OUT (1bp, +250ms, seen +1c, ${size} contracts; the managing order +${MANAGE_DELAY_MS}ms)`);
  console.log("   Sell everything if our side's bid <= 0.30 (limit 1c under it); buy " + size + " more if its ask >= 0.75 (limit 1c over).");
  console.log("   Rule fixed before this run from earlier days' results; fills walk the recorded book, Kalshi's fee on every order.");
  const acts = {};
  for (const x of xs) acts[x.act] = (acts[x.act] || 0) + 1;
  console.log(`   ${xs.length} filled positions; at ${MANAGE_SECS}s out: ${Object.entries(acts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  const head = "   variant                 positions   P&L        per ctr  t(day)   earlier    later";
  console.log(head);
  const row = (label, key) => {
    const S = dayStats(xs.map(x => ({ day: x.day, ctrs: x.n, pnl: x[key] })));
    console.log(`   ${label.padEnd(24)} ${String(xs.length).padStart(8)}  ${(S.pnl >= 0 ? "+$" : "-$") + Math.abs(S.pnl).toFixed(2).padStart(7)}  ${cents(S.perCtr).padStart(8)} ${tt(S.t).padStart(6)}  ${cents(S.earlyPerCtr).padStart(8)} ${cents(S.latePerCtr).padStart(8)}`);
  };
  row("hold (as live)", "base");
  row("sell the underdog only", "sell");
  row("add to the favourite only", "add");
  row("sell and add", "both");
  row("sell and add, 1c worse", "bothWorse");
  // Each action on its own: what it changed on the positions it touched.
  for (const a of ["sell", "add"]) {
    const ys = xs.filter(x => x.act === a);
    if (!ys.length) { console.log(`   ${a}: never triggered`); continue; }
    const filled = ys.filter(x => x.k > 0), delta = ys.map(x => ({ day: x.day, ctrs: x.k, pnl: x[a] - x.base }));
    const S = dayStats(delta), q = ys.reduce((s, x) => s + (a === "sell" ? x.quote.bid : x.quote.ask), 0) / ys.length;
    console.log(`   ${a}: ${ys.length} triggered, ${filled.length} filled (${S.ctrs} contracts); our side's ${a === "sell" ? "bid" : "ask"} averaged ${q.toFixed(3)} and it went on to win ${pct(ys.filter(x => x.won).length / ys.length)};`
      + ` the ${a} changed P&L by ${(S.pnl >= 0 ? "+$" : "-$") + Math.abs(S.pnl).toFixed(2)} (${cents(S.perCtr)} per contract traded, t ${tt(S.t)})`);
  }
  console.log("   A sale is worth it when our side, at that bid, wins LESS often than the bid says; an add when the favourite wins MORE");
  console.log("   often than its ask plus fee. \"too late\" positions were filled after the 15s mark and are held in every row.");
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
