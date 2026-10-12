// Big prints on the 15-minute markets: do large trades predict the
// outcome, and would following them have paid? (lib/bigPrint.js)
//
// Kalshi and Polymarket US publish no trader identity, so a whale there is
// a big trade, not a person. Reads every trade from the private
// stream-archive bucket — Kalshi's under m15/, .us's under pmus15/ — and
// the settled results from m15_markets. Writes nothing.
//
//   node scripts/m15-bigprint.mjs [--days=12] [SERIES ...]
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { pmusTakerFee } from "../lib/venueCompare.js";
import { usTakerSide } from "../lib/m15Venues.js";
import { parsePmusSlug, kalshiM15Ticker } from "../lib/pmus15.js";
import { windowRecords, newAgg, add, summary, bandOf, SIZE_BANDS, TIME_BANDS, FOLLOW_MIN, FOLLOW_DELAYS_MS } from "../lib/bigPrint.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }
const opt = (name, d) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : d; };
const DAYS = Math.min(Number(opt("days", 12)), 30);
const SINCE_MS = Date.now() - DAYS * 86400000, SINCE = new Date(SINCE_MS).toISOString();
const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M", "KXGOLD15M");

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const wanted = new Map();   // kalshi ticker -> { close, result, series }
for (const s of series) {
  const mk = await pageAll(rest, "m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}`, { key: "close_time", dedupeOn: "ticker" });
  for (const m of mk) if (m.result === "yes" || m.result === "no") wanted.set(m.ticker, { close: Date.parse(m.close_time), result: m.result, series: s });
}
console.log(`BIG PRINTS — ${series.join(", ")}, settled since ${SINCE.slice(0, 10)}: ${wanted.size} windows`);

const reader = archiveReader({ url: URL, key: KEY });
const kFee = (p, q) => kalshiTakerFee(p, q, 1), uFee = (p, q) => pmusTakerFee(p, q);
const groups = new Map();   // `${venue}|${series}` -> { cal, fol }
let nTrades = 0, nWindows = 0, noTime = 0;
// Each window is reduced as soon as the record has moved a minute past its
// close and then dropped: holding every trade of a fortnight ran the
// runner's 4GB heap out on the first attempt.
function finalize(venue, ticker, ts) {
  const m = wanted.get(ticker), g = `${venue}|${m.series}`;
  if (!groups.has(g)) groups.set(g, { cal: newAgg(), fol: newAgg() });
  const G = groups.get(g), day = new Date(m.close).toISOString().slice(0, 10);
  const { rows, follows } = windowRecords(ts, { close: m.close, result: m.result, fee: venue === "kalshi" ? kFee : uFee });
  nTrades += rows.length; nWindows++;
  for (const r of rows) {
    const sb = bandOf(SIZE_BANDS, r.n), tb = bandOf(TIME_BANDS, r.secs);
    if (sb < 0 || tb < 0) continue;
    for (const key of [`${sb}|all`, `${sb}|${tb}`]) add(G.cal, key, day, r.edge, { won: r.won, paid: r.paid, ctrs: r.n });
  }
  for (const f of follows) {
    if (!f.filled || f.secs > TIME_BANDS.at(-1)[1]) continue;
    for (const min of FOLLOW_MIN) if (f.n >= min) add(G.fol, `${min}|${f.delay}`, day, f.edge);
  }
}
// One pass over a venue's hourly files, in order. `toTrade(o)` returns
// [ticker, { x, n, side, paid }] or null.
async function pass(venue, top, keep, toTrade) {
  const files = await reader.listRange(top, SINCE_MS - 3600000, Date.now());
  const open = new Map();
  let watermark = -Infinity;
  for (const f of files) {
    await reader.eachLine(f.path, o => {
      const r = toTrade(o);
      if (!r) return;
      const [ticker, t] = r;
      if (!Number.isFinite(t.x)) { noTime++; return; }
      if (t.x > watermark) watermark = t.x;
      if (!open.has(ticker)) open.set(ticker, []);
      open.get(ticker).push(t);
    }, keep);
    for (const [ticker, ts] of open) if (wanted.get(ticker).close + 60000 < watermark) { finalize(venue, ticker, ts); open.delete(ticker); }
  }
  for (const [ticker, ts] of open) finalize(venue, ticker, ts);
  return files.length;
}
// Kalshi: yp is YES's price; the taker bought `side`, so paid YES's price
// or NO's (1 - yp).
const needles = series.map(s => `"m":"${s}-`);
const seenK = new Set(); let dupes = 0;
const kFiles = await pass("kalshi", "m15", line => line.startsWith('{"k":"tr"') && needles.some(n => line.includes(n)), o => {
  if (!wanted.has(o.m) || (o.side !== "yes" && o.side !== "no")) return null;
  // Kalshi numbers every trade; a restart that wrote one twice counts once.
  if (o.id) { if (seenK.has(o.id)) { dupes++; return null; } seenK.add(o.id); }
  return [o.m, { x: o.x, n: Number(o.n), side: o.side, paid: o.side === "yes" ? o.yp : 1 - o.yp }];
});
// Polymarket US: p is Up's price for every intent (measured 2026-10-04,
// CLAUDE.md), and Up is YES.
const uFiles = await pass("polyus", "pmus15", line => line.startsWith('{"k":"tr"'), o => {
  const p = parsePmusSlug(o.m), tk = p && kalshiM15Ticker(p.asset, p.close);
  if (!tk || !wanted.has(tk)) return null;
  const side = usTakerSide(o.intent);
  if (!side || !(o.p > 0 && o.p < 1)) return null;
  return [tk, { x: o.x, n: Number(o.q), side, paid: side === "yes" ? o.p : 1 - o.p }];
});
console.log(`trades read: ${nTrades.toLocaleString()} in ${nWindows} venue-windows (${kFiles} + ${uFiles} hourly files)${noTime ? `; ${noTime} dropped for no exchange time` : ""}${dupes ? `; ${dupes} duplicate Kalshi trade ids dropped` : ""}`);

const c = v => `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`;
const fmtBand = ([lo, hi]) => hi === Infinity ? `${lo.toLocaleString()}+` : `${lo.toLocaleString()}-${hi.toLocaleString()}`;
for (const [g, G] of [...groups].sort()) {
  const [venue, s] = g.split("|");
  console.log(`\n${"=".repeat(96)}\n${s} on ${venue === "kalshi" ? "Kalshi" : "Polymarket US"}\n${"=".repeat(96)}`);
  console.log("  CALIBRATION — every taker trade, each counted once; edge = won - paid - fee, per contract");
  console.log("  size (contracts)   trades      paid    won     edge  t(days) | edge by time to close: 0-60s   60-180s  180-420s  420-900s");
  SIZE_BANDS.forEach((b, sb) => {
    const a = summary(G.cal.get(`${sb}|all`));
    if (!a) return;
    const byT = TIME_BANDS.map((_, tb) => { const x = summary(G.cal.get(`${sb}|${tb}`)); return x ? `${c(x.edge).padStart(8)}(${String(x.n).padStart(5)})` : "        —      "; }).join(" ");
    console.log(`  ${fmtBand(b).padEnd(16)} ${String(a.n).padStart(8)}  ${(100 * a.paid).toFixed(1).padStart(6)}% ${(100 * a.won).toFixed(1).padStart(6)}% ${c(a.edge).padStart(8)} ${a.t == null ? "   —" : a.t.toFixed(1).padStart(6)}  | ${byT}`);
  });
  console.log("  FOLLOWING — buy the big print's side 10 contracts at the next same-side taker's price, L later; held to settlement, taker fee");
  for (const min of FOLLOW_MIN) {
    const cells = FOLLOW_DELAYS_MS.map(L => { const x = summary(G.fol.get(`${min}|${L}`)); return x ? `${L === 0 ? "own price" : `+${L}ms`}: ${c(x.edge)} (n${x.n}, t ${x.t == null ? "—" : x.t.toFixed(1)})` : null; }).filter(Boolean);
    if (cells.length) console.log(`  prints of ${min.toLocaleString()}+  ${cells.join("  |  ")}`);
  }
}
console.log(`
READING THIS
- "paid" is the average price the taker paid for the side it bought, i.e. what the market said; "won" is how
  often that side settled; "edge" subtracts the taker fee. A size band whose edge is clearly above the small
  trades' knows something the price did not; one at the same level does not.
- "own price" is what the big trader paid, which no follower can get. The later columns are what was still
  offered: the price the next taker on that side paid. Not filled (nothing traded after it) is left out.
- t is over DAYS, not trades; under ~2 is noise. Every row is an upper bound: no queue, no slippage past the
  next print, and a follower's own order would move a thin book.
- No trader identity exists on either venue: this is big trades, not big traders.`);
