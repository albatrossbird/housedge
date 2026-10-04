// What the two 15-minute backtests share once each has built its price
// paths: which strategies to run, Kalshi's fee multiplier, and the
// report. scripts/m15-backtest.mjs reads the 15-second poller's path from
// Postgres; scripts/m15-archive-backtest.mjs reads the WebSocket
// archive's once-a-second book. Both run lib/m15Backtest.js and print
// through here, so a result from one can be laid beside the other.

import { PRESETS, runMarket, findEntry, summarize, splitHalves, parseStrategies } from "./m15Backtest.js";
import { PAPER_RULES } from "./paperM15.js";
import { makerTrade, selection } from "./m15Maker.js";
import { kalshiMakerFee, kalshiTakerFee } from "./fees.js";
import { ruleStats, calibration } from "./m15Stats.js";
import { pmusFee, pmusMakerFee, bestOfBoth, legsTrade, delayedFill, VENUE_DELAYS_MS } from "./m15Venues.js";

// --strategies=a,b|all and/or --strategy=<JSON>|paper. A custom strategy
// (or map of them) replaces the presets unless presets are also named.
// `paper` is the paper bot's own list (lib/paperM15.js), so a backtest of
// "what the bot trades" cannot drift from what the bot trades.
export function strategiesFromArgs(argv) {
  const opt = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  const strategies = {};
  const custom = opt("strategy") || "";
  if (custom === "paper") Object.assign(strategies, PAPER_RULES);
  else if (custom) Object.assign(strategies, parseStrategies(custom));
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
  return (await seriesFees(series))?.mult ?? null;
}

// The multiplier and the fee_type, which decides what a MAKER pays
// (lib/fees.js kalshiMakerFee). Null when Kalshi does not answer.
export async function seriesFees(series) {
  try {
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/series/${series}`, { headers: { "User-Agent": "marketslap/1.0" } });
    if (!r.ok) return null;
    const s = (await r.json())?.series;
    const m = Number(s?.fee_multiplier);
    return Number.isFinite(m) ? { mult: m, feeType: s?.fee_type ?? null, category: s?.category ?? null } : null;
  } catch { return null; }
}

// Trading days a year, for annualising a daily Sharpe: crypto trades
// every day, everything else (gold, FX, indices) roughly every weekday.
export const daysPerYearFor = category => (category === "Crypto" ? 365 : 252);

const $ = v => (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
const c = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}c`;
export const pct = v => `${(100 * v).toFixed(1)}%`;

// One series' table. `covered` are the settled markets that have a path.
export function printSeriesTable({ strategies, covered, paths, size, mult, requireDepth, daysPerYear = 365, log = console.log }) {
  log(`\n  ${"strategy".padEnd(16)} ${"trades".padStart(6)} ${"days".padStart(4)} ${"win".padStart(6)} ${"avg in".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)} ${"per day".padStart(8)} ${"t(days)".padStart(7)} ${"max DD".padStart(8)}  ${"1c worse".padStart(9)}`);
  const out = {}, tradesBy = {};
  for (const [name, strat] of Object.entries(strategies)) {
    const trades = covered.map(m => runMarket(strat, m, paths.get(m.ticker), { size, mult, requireDepth })).filter(Boolean);
    tradesBy[name] = trades;
    const S = summarize(trades);
    out[name] = S;
    if (!S.n) { log(`  ${name.padEnd(16)} ${"0".padStart(6)}   — never entered`); continue; }
    const H = splitHalves(trades), half = h => h.n ? `${h.days}d ${$(h.perDay)}/day ${c(h.pnlPerContract)}` : "—";
    log(`  ${name.padEnd(16)} ${String(S.n).padStart(6)} ${String(S.days).padStart(4)} ${pct(S.winRate).padStart(6)} ${S.avgEntry.toFixed(2).padStart(6)}  ${$(S.pnl).padStart(9)} ${c(S.pnlPerContract).padStart(8)} ${$(S.perDay).padStart(8)} ${(S.tDays == null ? "—" : S.tDays.toFixed(1)).padStart(7)} ${$(S.maxDrawdown).padStart(8)}  ${$(S.pnlSlip1c).padStart(9)}${S.early ? `   (${S.early} exited early)` : ""}`);
    if (S.days >= 2) log(`  ${"".padEnd(16)}   earlier days: ${half(H.early)}   |   later days: ${half(H.late)}`);
  }
  printOddsTable({ strategies, tradesBy, daysPerYear, log });
  return out;
}

// Priced against won, EV with a by-day range, Sharpe and Kelly, for the
// hold-to-settlement rules (lib/m15Stats.js says what each one means).
// A rule with early exits has no single price and payoff, so it is left out.
const pts = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pt`;
const rng2 = (r, f) => r ? `[${f(r.lo)}, ${f(r.hi)}]` : "[—]";
const c1 = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}c`;
const kel = k => k == null ? "—" : k <= 0 ? "0" : pct(k);
export function printOddsTable({ strategies, tradesBy, daysPerYear, log = console.log }) {
  const rows = Object.entries(strategies).filter(([n, s]) => !s.exit && tradesBy[n]?.length);
  if (!rows.length) return;
  log(`\n  PRICED vs WON, EV, SHARPE, KELLY (taker, held to settlement; ranges are 95%)`);
  log(`  ${"strategy".padEnd(16)} ${"n".padStart(4)} ${"priced".padStart(7)} ${"needs".padStart(6)} ${"won".padStart(6)} ${"won range".padStart(15)} ${"edge".padStart(7)}  ${"EV/ctr".padStart(7)} ${"EV range by day".padStart(17)}  ${"Sharpe d/yr".padStart(11)}  ${"Kelly".padStart(6)} ${"at low".padStart(6)}`);
  for (const [name] of rows) {
    const R = ruleStats(tradesBy[name], { daysPerYear });
    const sh = R.sharpeDaily == null ? "—" : `${R.sharpeDaily.toFixed(2)}/${R.sharpeAnnual.toFixed(1)}`;
    log(`  ${name.padEnd(16)} ${String(R.n).padStart(4)} ${pct(R.priced).padStart(7)} ${pct(R.breakeven).padStart(6)} ${pct(R.winRate).padStart(6)} ${rng2(R.winCI, v => (v * 100).toFixed(0)).padStart(15)} ${pts(R.edgePts).padStart(7)}  ${c1(R.evPerContract).padStart(7)} ${rng2(R.evBoot, c1).padStart(17)}  ${sh.padStart(11)}  ${kel(R.kelly).padStart(6)} ${kel(R.kellyLow).padStart(6)}`);
    const cal = calibration(tradesBy[name]).map(b => `${b.lo.toFixed(2)}-${Math.min(b.hi, 1).toFixed(2)}: n${b.n} priced ${pct(b.priced)} needs ${pct(b.breakeven)} won ${pct(b.won)}`);
    log(`  ${"".padEnd(16)}   by price: ${cal.join("  |  ")}`);
  }
  log(`  "priced" is the average entry price, i.e. the market's probability; "needs" adds Kalshi's fee: the win rate to
  break even. "won range" is a Wilson interval on decisions. EV's range resamples whole days, so it widens when
  the sample is a few days. Sharpe: daily P&L mean/sd, and x sqrt(${daysPerYear}) a year. Kelly is (won - needs)/(1 - needs)
  of bankroll per trade; "at low" uses the low end of the win-rate range (the lower of Wilson and the by-day
  bootstrap). 0 means do not bet. Size from "at low", and a fraction of it — a full Kelly on an estimated edge
  overbets.`);
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

// Resting orders beside the taker result, on the SAME decisions: only
// windows the replay could use, and only decisions whose order could be
// posted, are counted on either side, so the rows compare like for like.
export function printMakerSection({ strategies, covered, paths, size, mult, feeType, requireDepth, maker, variants, stats, latencyMs, cutoffSecs, log = console.log }) {
  log(`\n  RESTING ORDERS — the same decisions as a bid at the touch, landing +${latencyMs}ms after the deciding book, cancelled ${cutoffSecs}s before the close`);
  const sides = stats.sides;
  const agree = sides.total ? sides.agree / sides.total : null;
  log(`  maker fee on this series: ${feeType === "quadratic" ? "none (fee_type quadratic)" : feeType ?? "unknown"}; trade sides agree with the book on ${agree == null ? "—" : pct(agree)} of ${sides.total.toLocaleString()} trades`);
  if (agree != null && agree < 0.6) log(`  ::warning::recorded taker sides disagree with the book — fills below would be read from the wrong side; not trusting them`);
  if (kalshiMakerFee(0.5, 1, mult, feeType) == null) { log(`  ::warning::fee_type "${feeType}" is not one this model prices — resting fills skipped rather than guessed`); return; }
  log(`  ${"strategy".padEnd(14)} ${"variant".padEnd(10)} ${"posted".padStart(6)} ${"filled".padStart(6)} ${"ctrs".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)} ${"per day".padStart(8)} ${"t(days)".padStart(7)}   won when filled / not filled`);
  for (const [name, strat] of Object.entries(strategies)) {
    if (strat.exit) { log(`  ${name.padEnd(14)} — has an exit rule; resting entries are modelled for hold-to-settlement rules only`); continue; }
    const posted = covered.map(m => ({ m, r: maker.get(`${name}|${m.ticker}`) })).filter(x => x.r && x.r.sims.join?.status === "ok");
    if (!posted.length) { log(`  ${name.padEnd(14)} — no decision in a replayable window`); continue; }
    const wanted = posted.reduce((s, x) => s + x.r.decision.qty, 0);
    const row = (variant, trades, filledN, ctrs, sel) => {
      const S = summarize(trades);
      const money = S.n ? `${$(S.pnl).padStart(9)} ${c(S.pnlPerContract).padStart(8)} ${$(S.perDay).padStart(8)} ${(S.tDays == null ? "—" : S.tDays.toFixed(1)).padStart(7)}` : `${"$0.00".padStart(9)} ${"—".padStart(8)} ${"—".padStart(8)} ${"—".padStart(7)}`;
      const s2 = sel ? `   ${sel.winFilled == null ? "—" : pct(sel.winFilled)} / ${sel.winUnfilled == null ? "—" : pct(sel.winUnfilled)}` : "";
      log(`  ${(variant === "taker" ? name : "").padEnd(14)} ${variant.padEnd(10)} ${String(posted.length).padStart(6)} ${String(filledN).padStart(6)} ${pct(ctrs / wanted).padStart(6)}  ${money}${s2}`);
    };
    const taker = posted.map(x => runMarket(strat, x.m, paths.get(x.m.ticker), { size, mult, requireDepth })).filter(Boolean);
    row("taker", taker, taker.length, taker.reduce((s, t) => s + t.qty, 0), null);
    for (const v of variants) {
      const trades = [], sel = [];
      let filledN = 0, ctrs = 0;
      for (const { m, r } of posted) {
        const sim = r.sims[v];
        const t = makerTrade(m, r.decision, sim, { mult, feeType });
        if (t) { trades.push(t); filledN++; ctrs += t.qty; }
        sel.push({ filled: sim.filled, won: r.decision.side === m.result });
      }
      row(v, trades, filledN, ctrs, selection(sel));
    }
  }
}

export function printMakerFooter({ log = console.log } = {}) {
  log(`
RESTING ORDERS, READING THEM
- "join" waits behind everything already at the bid and moves up only as trades at that price clear the queue
  (cancels ahead are assumed never to happen): a pessimistic bound. "front" assumes it is first in line: the
  optimistic bound. The truth is between them. "improve" bids a cent inside a 2c+ spread, alone at its price.
  "join+take" rests like join, then buys whatever is unfilled at the ask just before the cutoff.
- "won when filled / not filled": how often the side won on decisions where the resting order got a fill,
  against those where it did not. If the first is clearly lower, fills arrive when the side is about to lose
  (adverse selection), and the saved spread and fee are being paid for in outcomes.
- Taker and resting rows count the same decisions. Unfilled decisions make $0, so compare the P&L columns.
- Replayed only where the archive holds every change: the final two minutes, windows without gaps or socket
  events. Our own order is not in the replayed book and nobody reacts to it.`);
}

// The same rules on Kalshi and on Polymarket US (lib/m15Venues.js), on the
// windows BOTH venues listed and both recorders covered — a window only one
// venue has is left out of all three rows, so they compare like for like.
//   kalshi       decided and bought on Kalshi's book, Kalshi's fee
//   polyus       decided and bought on the .us book, .us's fee
//   best of both decided on Kalshi's book; each contract bought where it is
//                cheaper all-in at that second, spilling to the other venue
// With usMaker, the .us decisions are also replayed as resting orders on
// the .us tape, where makers are PAID a rebate.
export function printVenueSection({ strategies, covered, kPaths, uPaths, uFull = null, size, mult, requireDepth, daysPerYear = 365,
  usMaker = null, usStats = null, variants = [], latencyMs, cutoffSecs, delaySnaps = null, log = console.log }) {
  const both = covered.filter(m => (uPaths.get(m.ticker) || []).length);
  if (!both.length) return;
  // Best of both reads the .us book as it stood AT the decision instant:
  // the once-a-second path keeps each second's LAST book, which for a
  // decision early in a second is stamped after it.
  const uAt = uFull || uPaths;
  const kFee = (p, n) => kalshiTakerFee(p, n, mult);
  log(`\n  ACROSS VENUES — the same rules on Kalshi and Polymarket US, on the ${both.length} windows of ${covered.length} that both venues listed and both recorders covered`);
  log(`  ${"strategy".padEnd(14)} ${"venue".padEnd(12)} ${"trades".padStart(6)} ${"win".padStart(6)} ${"avg in".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)} ${"per day".padStart(8)} ${"t(days)".padStart(7)}  ${"needs".padStart(6)} ${"won range".padStart(11)} ${"Kelly low".padStart(9)}`);
  const line = (name, venue, trades) => {
    const S = summarize(trades);
    if (!S.n) { log(`  ${name.padEnd(14)} ${venue.padEnd(12)} ${"0".padStart(6)}   — never entered`); return; }
    const R = ruleStats(trades, { daysPerYear });
    log(`  ${name.padEnd(14)} ${venue.padEnd(12)} ${String(S.n).padStart(6)} ${pct(S.winRate).padStart(6)} ${S.avgEntry.toFixed(2).padStart(6)}  ${$(S.pnl).padStart(9)} ${c(S.pnlPerContract).padStart(8)} ${$(S.perDay).padStart(8)} ${(S.tDays == null ? "—" : S.tDays.toFixed(1)).padStart(7)}  ${pct(R.breakeven).padStart(6)} ${`[${(R.winCI.lo * 100).toFixed(0)}, ${(R.winCI.hi * 100).toFixed(0)}]`.padStart(11)} ${kel(R.kellyLow).padStart(9)}`);
  };
  for (const [name, strat] of Object.entries(strategies)) {
    if (strat.exit) continue;
    const kTrades = both.map(m => runMarket(strat, m, kPaths.get(m.ticker), { size, mult, requireDepth })).filter(Boolean);
    const uTrades = both.map(m => runMarket(strat, m, uPaths.get(m.ticker), { size, requireDepth, fee: pmusFee })).filter(Boolean);
    const best = [];
    let decisions = 0, usCheaper = 0, usQty = 0, qtyAll = 0, saved = 0, savedQty = 0;
    for (const m of both) {
      const path = kPaths.get(m.ticker).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
      const hit = findEntry(strat, m, path, { size, requireDepth });
      if (!hit) continue;
      decisions++;
      const r = bestOfBoth({ side: hit.side, t: hit.row.t, size, priceMax: strat.entry?.priceMax ?? 1, requireDepth, kRow: hit.row, uRows: uAt.get(m.ticker), kFee, uFee: pmusFee });
      const t = legsTrade(m, hit.side, hit.row.t, hit.row.secs, r.legs);
      if (!t) continue;
      best.push(t);
      const kq = r.quotes.find(q => q.venue === "kalshi"), uq = r.quotes.find(q => q.venue === "polyus");
      if (kq && uq && uq.unit < kq.unit - 1e-9) usCheaper++;
      for (const l of r.legs) { qtyAll += l.qty; if (l.venue === "polyus") usQty += l.qty; }
      if (kq) { saved += (kq.unit - (t.entry + t.entryFee / t.qty)) * t.qty; savedQty += t.qty; }
    }
    line(name, "kalshi", kTrades);
    line("", "polyus", uTrades);
    line("", "best of both", best);
    if (decisions) log(`  ${"".padEnd(14)} best of both: .us cheaper all-in at ${usCheaper} of ${decisions} decisions; ${usQty} of ${qtyAll} contracts bought there; ${savedQty ? c(saved / savedQty) : "—"} a contract against Kalshi's own price at the same moment`);
  }
  if (delaySnaps) printVenueDelay({ strategies, both, kPaths, uAt, size, mult, requireDepth, delaySnaps, log });
  if (usMaker) printUsMakerRows({ strategies, both, uPaths, size, requireDepth, usMaker, usStats, variants, latencyMs, cutoffSecs, log });
  log(`  Same claim, same outcome (Kalshi's result). A decision where the .us book was more than 2s old buys on Kalshi only.
  Every row is a taker at the touch, an upper bound; "best of both" also assumes two venues can be hit in the same second.`);
}

// Resting orders on the .us tape. The reading of SHORT trade prices (Up
// or Down) is the one that agrees with the book; below 60% agreement the
// fills are not trusted and nothing is printed but the warning.
function printUsMakerRows({ strategies, both, uPaths, size, requireDepth, usMaker, usStats, variants, latencyMs, cutoffSecs, log }) {
  const rate = s => (s.total ? s.agree / s.total : 0);
  const mode = rate(usStats.sides.short) > rate(usStats.sides.long) ? "short" : "long";
  const agree = usStats.sides[mode];
  log(`\n  RESTING ORDERS ON POLYMARKET US (makers are paid 0.0125 x p(1-p)), the .us decisions as a bid at the touch, +${latencyMs}ms, cancelled ${cutoffSecs}s before the close`);
  log(`  ${usStats.windows} windows replayed; left out: ${JSON.stringify(usStats.excluded)}; SHORT trade prices read as ${mode === "short" ? "Down's" : "Up's"} (agree ${pct(rate(usStats.sides.short))} vs ${pct(rate(usStats.sides.long))}); trade sides agree with the book on ${pct(rate(agree))} of ${agree.total.toLocaleString()} trades`);
  if (rate(agree) < 0.6) { log(`  ::warning::.us trade sides disagree with the book under either reading — resting fills not trusted, not printed`); return; }
  log(`  ${"strategy".padEnd(14)} ${"variant".padEnd(10)} ${"posted".padStart(6)} ${"filled".padStart(6)}  ${"P&L".padStart(9)} ${"per ctr".padStart(8)}   won when filled / not filled`);
  for (const [name, strat] of Object.entries(strategies)) {
    if (strat.exit) continue;
    const posted = both.map(m => ({ m, r: usMaker.get(`${name}|${m.ticker}`) })).filter(x => x.r && x.r.sims[mode]?.join?.status === "ok");
    if (!posted.length) { log(`  ${name.padEnd(14)} — no .us decision in a replayable window`); continue; }
    const taker = posted.map(x => runMarket(strat, x.m, uPaths.get(x.m.ticker), { size, requireDepth, fee: pmusFee })).filter(Boolean);
    const T = summarize(taker);
    log(`  ${name.padEnd(14)} ${"taker".padEnd(10)} ${String(posted.length).padStart(6)} ${String(T.n || 0).padStart(6)}  ${$(T.pnl || 0).padStart(9)} ${(T.n ? c(T.pnlPerContract) : "—").padStart(8)}`);
    for (const v of variants) {
      const trades = [], sel = [];
      for (const { m, r } of posted) {
        const sim = r.sims[mode][v];
        const t = makerTrade(m, r.decision, sim, { makerFee: pmusMakerFee, takerFee: pmusFee });
        if (t) trades.push(t);
        sel.push({ filled: sim.filled, won: r.decision.side === m.result });
      }
      const S = summarize(trades), L = selection(sel);
      log(`  ${"".padEnd(14)} ${v.padEnd(10)} ${String(posted.length).padStart(6)} ${String(trades.length).padStart(6)}  ${$(S.pnl || 0).padStart(9)} ${(S.n ? c(S.pnlPerContract) : "—").padStart(8)}   ${L.winFilled == null ? "—" : pct(L.winFilled)} / ${L.winUnfilled == null ? "—" : pct(L.winUnfilled)}`);
    }
  }
}

// Best of both, and Kalshi alone, with the orders arriving DELAY ms after
// the decision as limits at the prices seen (lib/m15Venues.js). Counted
// only where both venues' books are known at every delay, so every row
// is the same decisions. "+ rest on Kalshi" buys whatever did not fill at
// Kalshi's touch when the orders land, inside the rule's price cap.
function printVenueDelay({ strategies, both, kPaths, uAt, size, mult, requireDepth, delaySnaps, log }) {
  const kFee = (p, n) => kalshiTakerFee(p, n, mult), fees = { kalshi: kFee, polyus: pmusFee };
  const ratio = (a, b) => (b ? pct(a / b) : "—");
  const perCtr = (pnl, q) => (q ? c(pnl / q) : "—");
  log(`\n  DELAY — the same decisions, orders arriving later as limits at the prices seen; what is still offered at or better fills`);
  log(`  ${"strategy".padEnd(14)} ${"delay".padStart(6)}   ${"Kalshi alone".padEnd(24)}   ${"best of both".padEnd(42)}   ${"+ rest on Kalshi".padEnd(18)}`);
  log(`  ${"".padEnd(14)} ${"".padStart(6)}   ${"filled".padStart(6)} ${"per ctr".padStart(8)} ${"P&L".padStart(8)}   ${".us leg".padStart(7)} ${"Kalshi leg".padStart(10)} ${"per ctr".padStart(8)} ${"P&L".padStart(8)}       ${"per ctr".padStart(8)} ${"P&L".padStart(8)}`);
  for (const [name, strat] of Object.entries(strategies)) {
    if (strat.exit) continue;
    const agg = Object.fromEntries(VENUE_DELAYS_MS.map(d => [d, { k: { q: 0, w: 0, pnl: 0 }, b: { q: 0, pnl: 0, us: { got: 0, want: 0 }, ka: { got: 0, want: 0 } }, f: { q: 0, pnl: 0 } }]));
    let n = 0, left = 0;
    for (const m of both) {
      const path = kPaths.get(m.ticker).filter(r => r.t < m.close && r.secs > 0).sort((a, b) => a.t - b.t);
      const hit = findEntry(strat, m, path, { size, requireDepth });
      if (!hit) continue;
      const key = `${name}|${m.ticker}`, kS = delaySnaps.kalshi.get(key), uS = delaySnaps.polyus.get(key);
      if (!kS || !uS || VENUE_DELAYS_MS.some(d => !kS[d] || !uS[d])) { left++; continue; }
      const r = bestOfBoth({ side: hit.side, t: hit.row.t, size, priceMax: strat.entry?.priceMax ?? 1, requireDepth, kRow: hit.row, uRows: uAt.get(m.ticker), kFee, uFee: pmusFee });
      if (!r.legs.length) continue;
      n++;
      const won = hit.side === m.result, priceMax = strat.entry?.priceMax ?? 1;
      const kLeg = [{ venue: "kalshi", price: hit.price, qty: hit.qty }];
      for (const d of VENUE_DELAYS_MS) {
        const snaps = { kalshi: kS[d], polyus: uS[d] }, A = agg[d];
        const k = delayedFill({ legs: kLeg, side: hit.side, won, snaps, priceMax, fees });
        const b = delayedFill({ legs: r.legs, side: hit.side, won, snaps, priceMax, fees });
        const f = delayedFill({ legs: r.legs, side: hit.side, won, snaps, priceMax, fees, fallback: true });
        A.k.q += k.qty; A.k.w += k.wanted; A.k.pnl += k.pnl;
        A.b.q += b.qty; A.b.pnl += b.pnl;
        for (const [v, x] of Object.entries(b.legFills)) { const t = v === "polyus" ? A.b.us : A.b.ka; t.got += x.got; t.want += x.want; }
        A.f.q += f.qty; A.f.pnl += f.pnl;
      }
    }
    if (!n) { log(`  ${name.padEnd(14)} — no decision with both venues' books replayable${left ? ` (${left} left out)` : ""}`); continue; }
    VENUE_DELAYS_MS.forEach((d, i) => {
      const A = agg[d];
      log(`  ${(i ? "" : `${name} (${n})`).padEnd(14)} ${`+${d}ms`.padStart(6)}   ${ratio(A.k.q, A.k.w).padStart(6)} ${perCtr(A.k.pnl, A.k.q).padStart(8)} ${$(A.k.pnl).padStart(8)}   ${ratio(A.b.us.got, A.b.us.want).padStart(7)} ${ratio(A.b.ka.got, A.b.ka.want).padStart(10)} ${perCtr(A.b.pnl, A.b.q).padStart(8)} ${$(A.b.pnl).padStart(8)}       ${perCtr(A.f.pnl, A.f.q).padStart(8)} ${$(A.f.pnl).padStart(8)}`);
    });
    if (left) log(`  ${"".padEnd(14)} ${left} decisions left out: a venue's book not replayable at some delay (gap, socket event, or outside the record)`);
  }
  log(`  +0ms reads both books at the decision instant: it should fill nearly everything, and is a check on the replay, not a result.
  A .us leg that fills far less than the Kalshi leg as the delay grows is a cheap quote that was stale: others take it first.`);
}
