// Backtest a RULE FILE (strategies/*.json, lib/m15RuleBook.js) over the
// WebSocket archive: Kalshi's book once a second with its top ten levels,
// BRTI from the same archive, and Coinbase one-minute candles for the
// averages that need volume (lib/btcSignals.js).
//
// Unlike the entry-rule backtests, a rule file trades THROUGH the window
// — it can buy every ten seconds, add to a position, net against it, and
// exit on dollar profit or loss — so it is simulated tick by tick rather
// than as one entry held to the close.
//
// Usage:
//   node scripts/m15-rulebook-backtest.mjs --file=strategies/momentum-ladder.json [--days=7] [--out=actions.tsv]
//
// Four runs of the same file, side by side:
//   as written        first matching rule acts, fills walk the real book,
//                     Kalshi's taker fee, positions marked at the touch
//   +1s delay         the same, each order filling against the book a
//                     second after the decision
//   every match acts  every matching rule acts, not only the first
//   mid, no fees      every order fills in full at the mid with no fee:
//                     the OPTIMISTIC bound, which is what a simulator that
//                     ignores the book reports. Never a result to trade on.
//   resting, back / front of queue
//                     entries posted as resting orders at the touch, filled
//                     only by the recorded trade tape, half a second after
//                     the decision; exits still cross. "back" waits behind
//                     everything already at that price, "front" is first
//                     in line — the truth is between them.
//
// --venues adds the same file on Polymarket US, which lists this market
// (lib/pmus15.js): on the .us book alone with its fees, and on BOTH —
// decided on Kalshi's book, each contract bought where it is cheapest
// all-in, held and sold on the venue that bought it (lib/m15RuleBook.js
// runWindowBoth). Compared only on windows both venues covered end to end.
//
// The usable archive starts 2026-09-30 13:16 UTC: before then the recorder
// ran behind its socket, and lines without the exchange's timestamp are
// dropped rather than timed on receipt.
//
// Reads with the service-role key (the bucket is private, migration 0029)
// and Coinbase's public candles. Writes nothing to the database.

import { readFileSync, writeFileSync } from "node:fs";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { archiveReader } from "../lib/archiveRead.js";
import { seriesFees } from "../lib/m15BacktestReport.js";
import { coinbaseCandles } from "../lib/coinbaseCandles.js";
import { kalshiMakerFee } from "../lib/fees.js";
import { toCandles, newTicks, addTick, makeSignals } from "../lib/btcSignals.js";
import { compileRuleBook, runWindow, runWindowBoth, pmusOrderFee, summarize, rowAt } from "../lib/m15RuleBook.js";
import { parsePmusSlug, kalshiM15Ticker } from "../lib/pmus15.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private (migration 0029)"); process.exit(2); }

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const FILE = opt("file", "strategies/momentum-ladder.json");
const DAYS = Math.min(Number(opt("days", 7)), 30);
const OUT = opt("out", null);
const VENUES = process.argv.includes("--venues");
const ARCHIVE_USABLE_FROM = Date.parse("2026-09-30T13:16:00Z");
const SINCE_MS = Math.max(Date.now() - DAYS * 86400000, ARCHIVE_USABLE_FROM + 900000);
const SINCE = new Date(SINCE_MS).toISOString();

let book;
try { book = compileRuleBook(JSON.parse(readFileSync(FILE, "utf8"))); }
catch (e) { console.error(`::error::${FILE}: ${e.message}`); process.exit(2); }
const SERIES = book.series;
if (SERIES !== "KXBTC15M") { console.error(`::error::${FILE} trades ${SERIES}; only KXBTC15M has its underlying wired (lib/btcSignals.js)`); process.exit(2); }

// Venue variants, run only on windows both venues covered. The Kalshi
// rows reuse the main runs' results for those windows.
const VENUE_VARIANTS = {
  "kalshi alone": { reuse: "as written" },
  "kalshi alone +1s": { reuse: "+1s delay" },
  "polymarket us alone": { venue: "polyus" },
  "best of both": { venue: "both" },
  "best of both +1s": { venue: "both", latencyMs: 1000 },
};

const VARIANTS = {
  "as written": {},
  "+1s delay": { latencyMs: 1000 },
  "every match acts": { mode: "all" },
  "mid, no fees": { fill: "mid", fees: false, mark: "mid" },
  "resting, back": { entry: "maker", queue: "join", latencyMs: 500 },
  "resting, front": { entry: "maker", queue: "front", latencyMs: 500 },
};

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

console.log(`RULE-FILE BACKTEST — ${book.name} (${FILE}): ${book.rules.length} rules, every ${book.interval}s, max position ${book.maxPosition}, on ${SERIES}`);
console.log(`windows settled since ${SINCE.slice(0, 16)}Z`);

// 1. Settled windows and their results.
const wanted = new Map();
for (const m of await pageAll(rest, "m15_markets", "ticker,close_time,result",
  `series=eq.${SERIES}&result=not.is.null&close_time=gte.${SINCE}`, { key: "close_time", dedupeOn: "ticker" })) {
  if (m.result === "yes" || m.result === "no") wanted.set(m.ticker, { ticker: m.ticker, close: Date.parse(m.close_time), result: m.result });
}
if (!wanted.size) { console.log("nothing settled in the window"); process.exit(0); }

// 2. Coinbase candles from two hours before the first window opens: the
//    hour's VWAP and the EMA need history before the first decision.
const fee = await seriesFees(SERIES);
if (!fee) { console.error("::error::no fee_multiplier from Kalshi — not pricing fees by guess"); process.exit(1); }
// A fee type we do not know prices nothing rather than zero (lib/fees.js).
if (kalshiMakerFee(0.5, 100, fee.mult, fee.feeType) == null) { console.error(`::error::unknown fee_type "${fee.feeType}" — cannot price resting orders`); process.exit(1); }
const makerFee = (p, n) => kalshiMakerFee(p, n, fee.mult, fee.feeType);
const closes = [...wanted.values()].map(m => m.close);
const errors = [];
const candles = toCandles(await coinbaseCandles("BTC-USD", Math.floor((Math.min(...closes) - 900000 - 2 * 3600000) / 1000), Math.ceil(Math.max(...closes) / 1000), errors));
console.log(`Coinbase BTC-USD: ${candles.length} one-minute candles${errors.length ? ` — ::error::${errors.length} slices failed, signals have holes there` : ""}`);
for (const e of errors.slice(0, 5)) console.log(`  ${e}`);

// 2b. Polymarket US (--venues), read first: for each settled window, the
//     .us books the engine will read — the latest at or before each
//     decision tick, and a second later for the +1s run — top ten levels a
//     side like Kalshi's record. A window counts only if .us has books
//     from its first minute to its last and its socket never dropped
//     inside it; the others are left out of every venue row, Kalshi's too.
const usRows = new Map();
const usLeftOut = {};
if (VENUES) {
  const reader0 = archiveReader({ url: URL, key: KEY });
  const uFiles = await reader0.listRange("pmus15", SINCE_MS - 3600000, Date.now());
  const slugTo = new Map(), inflight = new Map(), conn = [], done = new Set();
  const info = slug => {
    if (!slugTo.has(slug)) {
      const p = parsePmusSlug(slug), tk = p && kalshiM15Ticker(p.asset, p.close);
      slugTo.set(slug, tk && wanted.has(tk) ? tk : null);
    }
    return slugTo.get(slug);
  };
  const leave = why => { usLeftOut[why] = (usLeftOut[why] || 0) + 1; };
  const finalizeUs = ticker => {
    done.add(ticker);
    const m = wanted.get(ticker), open = m.close - 900000;
    const all = (inflight.get(ticker) || []).sort((a, b) => a.t - b.t);
    inflight.delete(ticker);
    if (!all.length) return leave("no .us book");
    if (all[0].t > open + 60000 || all[all.length - 1].t < m.close - 60000) return leave(".us books do not span the window");
    if (conn.some(t => t >= open - 1000 && t <= m.close + 2000)) return leave(".us socket event");
    const keep = new Set();
    for (let g = open + book.interval * 1000; g < m.close; g += book.interval * 1000)
      for (const at of [g, g + 1000]) { const r = rowAt(all, at); if (r) keep.add(r); }
    usRows.set(ticker, [...keep].sort((a, b) => a.t - b.t));
  };
  const t1 = Date.now();
  let watermark = -Infinity, ubytes = 0;
  for (const f of uFiles) {
    ubytes += f.size || 0;
    await reader0.eachLine(f.path, o => {
      if (o.k === "conn") { if (Number.isFinite(o.t)) conn.push(o.t); return; }
      const tk = typeof o.m === "string" ? info(o.m) : null;
      if (!tk || !Number.isFinite(o.x)) return;
      if (o.x > watermark) watermark = o.x;
      const m = wanted.get(tk);
      if (o.x < m.close - 905000 || o.x >= m.close) return;
      const b = Array.isArray(o.b) ? o.b : [], a = Array.isArray(o.a) ? o.a : [];
      if (!b.length || !a.length) return;
      const bid = Number(b[0][0]), ask = Number(a[0][0]);
      if (!(bid > 0 && ask < 1 && bid < ask)) return;
      if (!inflight.has(tk)) inflight.set(tk, []);
      inflight.get(tk).push({ t: o.x, bid, ask, bids: b.slice(0, 10).map(([p, q]) => [Number(p), Number(q)]), asks: a.slice(0, 10).map(([p, q]) => [Number(p), Number(q)]) });
    }, line => line.startsWith('{"k":"pb"') || line.startsWith('{"k":"conn"'));
    for (const tk of [...inflight.keys()]) if (!done.has(tk) && wanted.get(tk).close + 60000 < watermark) finalizeUs(tk);
  }
  for (const tk of [...inflight.keys()]) if (!done.has(tk)) finalizeUs(tk);
  for (const tk of wanted.keys()) if (!done.has(tk) && !usRows.has(tk)) { done.add(tk); leave("no .us book"); }
  console.log(`polymarket us: ${uFiles.length} hourly files (${(ubytes / 1e6).toFixed(0)} MB compressed) in ${Math.round((Date.now() - t1) / 1000)}s; ${usRows.size} of ${wanted.size} windows covered end to end; left out ${JSON.stringify(usLeftOut)}`);
}

// 3. The archive, in order: books for the wanted windows, BRTI for the
//    signals. A window is run as soon as the record has moved a minute
//    past its close, so only the windows in flight are held in memory.
const ticks = newTicks();
const signalsAt = makeSignals(candles, ticks);
const reader = archiveReader({ url: URL, key: KEY });
const files = await reader.listRange("m15", SINCE_MS - 2 * 3600000, Date.now());
const needle = `"m":"${SERIES}-`;
const keep = line => ((line.startsWith('{"k":"b"') || line.startsWith('{"k":"tr"')) && line.includes(needle)) || (line.startsWith('{"k":"i5"') && line.includes('"id":"BRTI"'));
const rows = new Map(), tapes = new Map(), done = new Set();
const results = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, []]));
const venueResults = Object.fromEntries(Object.keys(VENUE_VARIANTS).map(v => [v, []]));
const tsv = [];
let watermark = -Infinity, bookLines = 0, noX = 0, tradeLines = 0;
const finalize = ticker => {
  done.add(ticker);
  const m = wanted.get(ticker), path = (rows.get(ticker) || []).sort((a, b) => a.t - b.t);
  const trades = (tapes.get(ticker) || []).sort((a, b) => a.x - b.x);
  rows.delete(ticker); tapes.delete(ticker);
  const byVariant = {};
  for (const [v, o] of Object.entries(VARIANTS)) {
    const r = byVariant[v] = runWindow(book, m, path, signalsAt, { ...o, mult: fee.mult, trades, makerFee });
    results[v].push(r);
    if (v === "as written" && OUT) for (const a of r.actions)
      tsv.push([m.ticker, new Date(a.t).toISOString(), ((m.close - a.t) / 1000).toFixed(0), a.rule, a.action, a.want ?? "", a.qty, a.closed ?? "", a.cash != null ? a.cash.toFixed(2) : "", a.fee ?? "", m.result, r.pnl.toFixed(2)].join("\t"));
  }
  const u = usRows.get(ticker);
  if (VENUES && u) for (const [v, o] of Object.entries(VENUE_VARIANTS)) {
    venueResults[v].push(o.reuse ? byVariant[o.reuse]
      : o.venue === "polyus" ? runWindow(book, m, u, signalsAt, { feeFn: pmusOrderFee })
      : runWindowBoth(book, m, path, u, signalsAt, { mult: fee.mult, latencyMs: o.latencyMs || 0 }));
  }
};
const t0 = Date.now();
for (const f of files) {
  await reader.eachLine(f.path, o => {
    if (o.k === "i5") { addTick(ticks, o.x, Number(o.v)); return; }
    const m = wanted.get(o.m);
    if (!m) return;
    if (o.k === "tr") {
      // Trades are timed on the exchange's clock too; one without it is dropped.
      if (!Number.isFinite(o.x) || o.x >= m.close || o.x < m.close - 905000 || (o.side !== "yes" && o.side !== "no")) return;
      if (!tapes.has(o.m)) tapes.set(o.m, []);
      tapes.get(o.m).push({ x: o.x, yp: Number(o.yp), n: Number(o.n), side: o.side });
      tradeLines++;
      return;
    }
    if (!Number.isFinite(o.x)) { noX++; return; }
    if (o.x > watermark) watermark = o.x;
    if (o.x < m.close - 905000 || o.x >= m.close) return;
    const L = Array.isArray(o.L) ? o.L : null;
    const bid = Number(o.b), ask = Number(o.a);
    if (!(bid > 0 && ask < 1 && bid < ask)) return;
    if (!rows.has(o.m)) rows.set(o.m, []);
    rows.get(o.m).push({ t: o.x, bid, ask, bids: L ? L[0] : [[bid, Number(o.bs) || 0]], asks: L ? L[1] : [[ask, Number(o.as) || 0]] });
    bookLines++;
  }, keep);
  for (const [ticker, m] of wanted) if (!done.has(ticker) && m.close + 60000 < watermark) finalize(ticker);
}
for (const ticker of wanted.keys()) if (!done.has(ticker)) finalize(ticker);
console.log(`archive: ${files.length} hourly files, ${bookLines.toLocaleString()} book rows, ${tradeLines.toLocaleString()} trades, ${ticks.x.length.toLocaleString()} BRTI seconds, ${Math.round((Date.now() - t0) / 1000)}s${noX ? `, ${noX} book lines dropped without an exchange timestamp` : ""}`);

// 4. Report.
const $ = x => `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`;
const pc = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "—");
console.log(`\n${"variant".padEnd(18)} ${"windows".padStart(7)} ${"traded".padStart(6)} ${"won".padStart(6)} ${"bought".padStart(10)} ${"fees".padStart(9)} ${"net P&L".padStart(11)} ${"per day".padStart(10)} ${"max DD".padStart(10)} ${"Sharpe".padStart(7)}`);
const S = {};
for (const v of Object.keys(VARIANTS)) {
  const s = S[v] = summarize(results[v]);
  console.log(`${v.padEnd(18)} ${String(s.windows).padStart(7)} ${String(s.traded).padStart(6)} ${pc(s.wins, s.traded).padStart(6)} ${s.contracts.toLocaleString().padStart(10)} ${("$" + s.fees.toFixed(2)).padStart(9)} ${$(s.pnl).padStart(11)} ${$(s.perDay).padStart(10)} ${$(s.maxDrawdown).padStart(10)} ${(s.sharpeAnnual == null ? "—" : s.sharpeAnnual.toFixed(1)).padStart(7)}`);
}
const A = S["as written"];
console.log(`\ndata: ${A.ticks.toLocaleString()} decision ticks read, ${A.stale.toLocaleString()} skipped for a missing or stale book, ${A.noSignal.toLocaleString()} with a Bitcoin signal missing (rules on it could not fire)`);
console.log(`book depth: ${A.shortfall.toLocaleString()} contracts asked for that the top ten levels could not fill`);
for (const v of ["resting, back", "resting, front"]) {
  const s = S[v];
  console.log(`${v}: ${s.makerFilled.toLocaleString()} of ${s.posted.toLocaleString()} posted contracts filled (${pc(s.makerFilled, s.posted)})`);
}

for (const v of ["as written", "resting, back", "mid, no fees"]) {
  const s = S[v];
  console.log(`\n── ${v}: by day`);
  for (const d of s.days) console.log(`  ${d.day}  ${String(d.windows).padStart(3)} windows  ${String(d.traded).padStart(3)} traded  ${$(d.pnl).padStart(11)}`);
  console.log(`── ${v}: P&L by the rule that opened the window`);
  for (const g of s.byOpener.sort((a, b) => b.pnl - a.pnl)) console.log(`  ${g.rule.padEnd(22)} ${String(g.windows).padStart(4)} windows  won ${pc(g.wins, g.windows).padStart(6)}  ${$(g.pnl).padStart(11)}`);
  console.log(`── ${v}: orders by rule (fired / filled / contracts)`);
  for (const g of s.byRule.sort((a, b) => b.fired - a.fired)) console.log(`  ${g.rule.padEnd(22)} ${String(g.fired).padStart(5)} ${String(g.filled).padStart(5)} ${g.contracts.toLocaleString().padStart(9)}`);
  console.log(`── ${v}: how positions ended: ${Object.entries(s.exits).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
}

// 5. Deeper: where the P&L came from, on the same trades.
const deep = (label, s) => {
  console.log(`\n── ${label}: where the P&L came from`);
  if (s.grossAtMid != null) console.log(`  at the mid, before costs ${$(s.grossAtMid).padStart(11)}   spread and depth paid ${("-$" + s.slip.toFixed(2)).padStart(10)}   fees ${("-$" + s.fees.toFixed(2)).padStart(10)}   = net ${$(s.pnl)}`);
  const c = s.concentration;
  if (c.k) console.log(`  best ${c.k} windows ${$(c.best)}, worst ${c.k} ${$(c.worst)}, the other ${s.traded - 2 * c.k} ${$(c.rest)}`);
  console.log(`  t(days) ${s.tDays == null ? "—" : s.tDays.toFixed(2)} over ${s.days.length} days${s.halves ? `; first ${s.halves.early.days} days ${$(s.halves.early.pnl)}, last ${s.halves.late.days} ${$(s.halves.late.pnl)}` : ""}`);
  console.log(`  by when the position opened:  ${s.bySecs.map(g => `${g.key} ${g.windows}w ${pc(g.wins, g.windows)} ${$(g.pnl)}`).join("  |  ")}`);
  console.log(`  by the price paid to open:    ${s.byPrice.map(g => `${g.key} ${g.windows}w ${pc(g.wins, g.windows)} ${$(g.pnl)}`).join("  |  ")}`);
};
deep("as written", S["as written"]);
deep("+1s delay", S["+1s delay"]);

if (VENUES) {
  const n = venueResults["kalshi alone"].length;
  console.log(`\n${"=".repeat(100)}\nKALSHI AND POLYMARKET US — the same file on the ${n} windows both venues covered end to end (of ${wanted.size}; left out ${JSON.stringify(usLeftOut)})\n${"=".repeat(100)}`);
  if (n) {
    console.log(`${"variant".padEnd(20)} ${"traded".padStart(6)} ${"won".padStart(6)} ${"bought".padStart(9)} ${"on .us".padStart(7)} ${"fees".padStart(9)} ${"spread".padStart(9)} ${"net P&L".padStart(11)} ${"per day".padStart(10)} ${"t(days)".padStart(7)} ${"max DD".padStart(10)}`);
    const V = {};
    for (const v of Object.keys(VENUE_VARIANTS)) {
      const s = V[v] = summarize(venueResults[v]);
      const onUs = v.startsWith("polymarket") ? s.contracts : s.bought.polyus;
      console.log(`${v.padEnd(20)} ${String(s.traded).padStart(6)} ${pc(s.wins, s.traded).padStart(6)} ${s.contracts.toLocaleString().padStart(9)} ${pc(onUs, s.contracts).padStart(7)} ${("$" + s.fees.toFixed(2)).padStart(9)} ${(s.slip == null ? "—" : "$" + s.slip.toFixed(2)).padStart(9)} ${$(s.pnl).padStart(11)} ${$(s.perDay).padStart(10)} ${(s.tDays == null ? "—" : s.tDays.toFixed(2)).padStart(7)} ${$(s.maxDrawdown).padStart(10)}`);
    }
    for (const v of ["best of both", "best of both +1s"]) {
      const r = V[v].routing;
      console.log(`${v}: ${r.usedUs} buys took a .us level; against Kalshi alone at the same moment they saved ${$(r.saved)} (${r.compared} comparable)${V[v].unsoldUs ? `; ${V[v].unsoldUs} .us contracts could not be sold for want of a .us book and were held` : ""}`);
    }
    for (const v of ["polymarket us alone", "best of both"]) deep(v, V[v]);
    console.log(`  Same windows on every row. "spread" is what fills paid beyond each venue's mid. Best of both is decided on
  Kalshi's book and assumes both venues can be hit in the same second; a .us level counts only from a book under 2s old.`);
  }
}

console.log(`
NOTES
- Fills are taker fills walked through the top ten levels of Kalshi's book as recorded once a second, so
  "as written" is the closest to what the file would have done; "+1s delay" is what a real order's flight costs.
- "resting" posts each entry at the touch and fills it only from recorded trades at or through that price, so
  its fills skew toward the moments the market moves against the order; exits still cross and pay.
- "mid, no fees" fills everything at the mid for free. If a simulator reports a figure near that row, the gap
  to "as written" is the spread, the depth and the fee it never charged.
- The price signal is BRTI, the index these markets settle on; the file asks for Coinbase BTC-USD, a few dollars
  away. VWAP, EMA, SMA and the 15-minute high/low come from completed Coinbase one-minute candles only.
- Days are not independent samples of anything but themselves; with a handful of them, a Sharpe describes those days.`);

if (OUT) { writeFileSync(OUT, ["ticker\tdecided_at\tsecs_left\trule\taction\twant\tfilled\tclosed\tcash\tfee\tresult\twindow_pnl", ...tsv].join("\n") + "\n"); console.log(`\nevery action of the "as written" run: ${OUT} (${tsv.length} rows)`); }
