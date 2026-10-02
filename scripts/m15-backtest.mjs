// Backtest trading strategies on Kalshi's 15-minute markets, over the
// recorded price path. The engine and its rules are lib/m15Backtest.js;
// this file reads and prints.
//
// Usage:
//   node scripts/m15-backtest.mjs [--days=21] [--size=10] [--strategies=fav-late,momentum|all]
//                                 [--strategy='{"entry":{...},"exit":{...}}' | '{"name":{...},...}']
//                                 [--assume-depth] [SERIES ...]
//
// A custom --strategy is a JSON object shaped like the presets in
// lib/m15Backtest.js. Reads with the service-role key (the recorded
// archives are private, migration 0028) and writes nothing.
//
// Run it ONE AT A TIME, and not 15:45-16:45 UTC while discovery and
// matching run: it reads a window of m15_quotes per settled market.

import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { readQuoteWindows } from "../lib/m15Reads.js";
import { PRESETS, runMarket, summarize, splitHalves, parseStrategies, toPathRow } from "../lib/m15Backtest.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the recorded archives are private (migration 0028)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DAYS = Number(opt("days", 21));
const SIZE = Number(opt("size", 10));
const ASSUME_DEPTH = process.argv.includes("--assume-depth");
// The live touch (book_bid/book_ask, depth) exists from this date. Before
// it every price came through a 15s cache (see CLAUDE.md) and there is no
// size at all, so nothing earlier is read.
const BOOK_FROM = Date.parse("2026-09-26T00:00:00Z");
const SINCE = new Date(Math.max(Date.now() - DAYS * 86400000, BOOK_FROM)).toISOString();

const strategies = {};
const custom = opt("strategy", "");
if (custom) {
  try { Object.assign(strategies, parseStrategies(custom)); }
  catch (e) { console.error(`::error::--strategy: ${e.message}`); process.exit(2); }
}
const names = opt("strategies", custom ? "" : "all");
for (const n of (names === "all" ? Object.keys(PRESETS) : names.split(",").map(s => s.trim()).filter(Boolean))) {
  if (!PRESETS[n]) { console.error(`::error::unknown strategy "${n}" — presets: ${Object.keys(PRESETS).join(", ")}`); process.exit(2); }
  strategies[n] = PRESETS[n];
}
const series = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!series.length) series.push("KXBTC15M", "KXGOLD15M");

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const readAll = (table, select, extra, key = "id", dedupeOn = null) =>
  pageAll(rest, table, select, String(extra).replace(/&+$/, ""), { key, dedupeOn });

async function feeMultiplier(s) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${s}`, { headers: { "User-Agent": "marketslap/1.0" } });
    if (!r.ok) return null;
    const m = Number((await r.json())?.series?.fee_multiplier);
    return Number.isFinite(m) ? m : null;
  } catch { return null; }
}

// How far before the close any strategy needs to look: its latest entry
// plus any momentum lookback.
const reach = Math.max(...Object.values(strategies).map(s => (s.entry?.secsMax ?? 900) + (s.entry?.lookbackSecs ?? 0)));
const fromSecs = Math.min(900 + 60, reach);

const $ = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const c = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`;
const pct = v => `${(100 * v).toFixed(1)}%`;

console.log(`BACKTEST — ${series.join(", ")}, settled since ${SINCE.slice(0, 10)}, ${SIZE} contracts an entry${ASSUME_DEPTH ? ", UNKNOWN DEPTH ASSUMED FILLABLE" : ""}`);
console.log(`strategies: ${Object.keys(strategies).join(", ")}`);

for (const s of series) {
  console.log(`\n${"=".repeat(96)}\n${s}\n${"=".repeat(96)}`);
  const mult = await feeMultiplier(s);
  if (mult == null) { console.log("::warning::could not read fee_multiplier from Kalshi — skipped rather than assuming 1"); continue; }

  const mk = await readAll("m15_markets", "ticker,close_time,result",
    `series=eq.${encodeURIComponent(s)}&result=not.is.null&close_time=gte.${SINCE}&`, "close_time", "ticker");
  const markets = mk.filter(m => m.result === "yes" || m.result === "no")
    .map(m => ({ ticker: m.ticker, close: Date.parse(m.close_time), result: m.result }));
  if (!markets.length) { console.log("  nothing settled in the window"); continue; }

  const q = await readQuoteWindows(readAll, markets, { fromSecs, toSecs: 0,
    select: "id,ticker,observed_at,secs_to_close,book_bid,book_ask,bid_depth_1c,ask_depth_1c" });
  const paths = new Map();
  for (const r of q) { const p = toPathRow(r); if (!p) continue; if (!paths.has(r.ticker)) paths.set(r.ticker, []); paths.get(r.ticker).push(p); }
  const covered = markets.filter(m => paths.has(m.ticker));
  const yesRate = covered.filter(m => m.result === "yes").length / (covered.length || 1);
  console.log(`fee_multiplier ${mult} | settled markets ${markets.length}, with a recorded live-book path ${covered.length} | settled YES ${pct(yesRate)}`);
  if (!covered.length) continue;

  console.log(`\n  ${"strategy".padEnd(16)} ${"trades".padStart(6)} ${"days".padStart(4)} ${"win".padStart(6)} ${"avg in".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)} ${"per day".padStart(8)} ${"t(days)".padStart(7)} ${"max DD".padStart(8)}  ${"1c worse".padStart(9)}`);
  for (const [name, strat] of Object.entries(strategies)) {
    const trades = covered.map(m => runMarket(strat, m, paths.get(m.ticker), { size: SIZE, mult, requireDepth: !ASSUME_DEPTH })).filter(Boolean);
    const S = summarize(trades);
    if (!S.n) { console.log(`  ${name.padEnd(16)} ${"0".padStart(6)}   — never entered`); continue; }
    const H = splitHalves(trades), half = h => h.n ? `${h.days}d ${$(h.perDay)}/day ${c(h.pnlPerContract)}` : "—";
    console.log(`  ${name.padEnd(16)} ${String(S.n).padStart(6)} ${String(S.days).padStart(4)} ${pct(S.winRate).padStart(6)} ${S.avgEntry.toFixed(2).padStart(6)}  ${$(S.pnl).padStart(9)} ${c(S.pnlPerContract).padStart(8)} ${$(S.perDay).padStart(8)} ${(S.tDays == null ? "—" : S.tDays.toFixed(1)).padStart(7)} ${$(S.maxDrawdown).padStart(8)}  ${$(S.pnlSlip1c).padStart(9)}${S.early ? `   (${S.early} exited early)` : ""}`);
    if (S.days >= 2) console.log(`  ${"".padEnd(16)}   earlier days: ${half(H.early)}   |   later days: ${half(H.late)}`);
  }
}

console.log(`
READING THIS
- P&L is in dollars at ${SIZE} contracts an entry (fewer where the book held less), after Kalshi's taker fee.
- "per ctr" is the edge per contract; "1c worse" is the same trades with every fill a cent worse, because
  fills are priced at the touch and the depth used reaches one cent past it. If only the first column is
  positive, the edge is the size of the modelling error.
- "t(days)" is mean daily P&L over its standard error across DAYS. Under ~2 is noise; with few days it is
  noise whatever it says. Consecutive windows ride the same underlying, so trades are not the sample.
- "earlier / later days" splits the same trades by date. A rule chosen because it looked best over all the
  days is partly fitted to them; one that only works in one half is describing the sample, not the market.
- Taker only, filled at the recorded 15-second quote with no latency: an upper bound for a real account.`);
