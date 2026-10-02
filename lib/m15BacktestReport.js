// What the two 15-minute backtests share once each has built its price
// paths: which strategies to run, Kalshi's fee multiplier, and the
// report. scripts/m15-backtest.mjs reads the 15-second poller's path from
// Postgres; scripts/m15-archive-backtest.mjs reads the WebSocket
// archive's once-a-second book. Both run lib/m15Backtest.js and print
// through here, so a result from one can be laid beside the other.

import { PRESETS, runMarket, summarize, splitHalves, parseStrategies } from "./m15Backtest.js";

// --strategies=a,b|all and/or --strategy=<JSON>. A custom strategy (or
// map of them) replaces the presets unless presets are also named.
export function strategiesFromArgs(argv) {
  const opt = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  const strategies = {};
  const custom = opt("strategy") || "";
  if (custom) Object.assign(strategies, parseStrategies(custom));
  const names = opt("strategies") ?? (custom ? "" : "all");
  for (const n of (names === "all" ? Object.keys(PRESETS) : names.split(",").map(s => s.trim()).filter(Boolean))) {
    if (!PRESETS[n]) throw new Error(`unknown strategy "${n}" — presets: ${Object.keys(PRESETS).join(", ")}`);
    strategies[n] = PRESETS[n];
  }
  return strategies;
}

// How far before the close any strategy needs the path: its latest entry
// plus any momentum lookback, capped at a whole window and a minute.
export function reachSecs(strategies) {
  const r = Math.max(...Object.values(strategies).map(s => (s.entry?.secsMax ?? 900) + (s.entry?.lookbackSecs ?? 0)));
  return Math.min(900 + 60, r);
}

// Kalshi's per-series fee multiplier. Null rather than a guess: a missing
// multiplier is not 1 and certainly not 0 (see lib/fees.js).
export async function feeMultiplier(series) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${series}`, { headers: { "User-Agent": "marketslap/1.0" } });
    if (!r.ok) return null;
    const m = Number((await r.json())?.series?.fee_multiplier);
    return Number.isFinite(m) ? m : null;
  } catch { return null; }
}

const $ = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const c = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`;
export const pct = v => `${(100 * v).toFixed(1)}%`;

// One series' table. `covered` are the settled markets that have a path.
export function printSeriesTable({ strategies, covered, paths, size, mult, requireDepth, log = console.log }) {
  log(`\n  ${"strategy".padEnd(16)} ${"trades".padStart(6)} ${"days".padStart(4)} ${"win".padStart(6)} ${"avg in".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)} ${"per day".padStart(8)} ${"t(days)".padStart(7)} ${"max DD".padStart(8)}  ${"1c worse".padStart(9)}`);
  const out = {};
  for (const [name, strat] of Object.entries(strategies)) {
    const trades = covered.map(m => runMarket(strat, m, paths.get(m.ticker), { size, mult, requireDepth })).filter(Boolean);
    const S = summarize(trades);
    out[name] = S;
    if (!S.n) { log(`  ${name.padEnd(16)} ${"0".padStart(6)}   — never entered`); continue; }
    const H = splitHalves(trades), half = h => h.n ? `${h.days}d ${$(h.perDay)}/day ${c(h.pnlPerContract)}` : "—";
    log(`  ${name.padEnd(16)} ${String(S.n).padStart(6)} ${String(S.days).padStart(4)} ${pct(S.winRate).padStart(6)} ${S.avgEntry.toFixed(2).padStart(6)}  ${$(S.pnl).padStart(9)} ${c(S.pnlPerContract).padStart(8)} ${$(S.perDay).padStart(8)} ${(S.tDays == null ? "—" : S.tDays.toFixed(1)).padStart(7)} ${$(S.maxDrawdown).padStart(8)}  ${$(S.pnlSlip1c).padStart(9)}${S.early ? `   (${S.early} exited early)` : ""}`);
    if (S.days >= 2) log(`  ${"".padEnd(16)}   earlier days: ${half(H.early)}   |   later days: ${half(H.late)}`);
  }
  return out;
}

export function printFooter({ size, fills, log = console.log }) {
  log(`
READING THIS
- P&L is in dollars at ${size} contracts an entry (fewer where the book held less), after Kalshi's taker fee.
- "per ctr" is the edge per contract; "1c worse" is the same trades with every fill a cent worse, because
  fills are priced at the touch and the depth used reaches one cent past it. If only the first column is
  positive, the edge is the size of the modelling error.
- "t(days)" is mean daily P&L over its standard error across DAYS. Under ~2 is noise; with few days it is
  noise whatever it says. Consecutive windows ride the same underlying, so trades are not the sample.
- "earlier / later days" splits the same trades by date. A rule chosen because it looked best over all the
  days is partly fitted to them; one that only works in one half is describing the sample, not the market.
- Taker only, ${fills}, with no latency: an upper bound for a real account.`);
}
