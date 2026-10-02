// PAPER-trade the 15-minute rules live: decide on Kalshi's real order book,
// record what would have filled, settle it, and never send an order.
//
// WHAT IT DOES, per series (default KXBTC15M and KXGOLD15M):
//   - finds the window closing next, and in its final minutes reads
//     /markets/<ticker>/orderbook about once a second — uncached, unlike
//     /markets, so this is the book a live bot would see;
//   - runs every rule in PAPER_RULES (lib/paperM15.js) through findEntry,
//     the SAME decision the backtests use, on the rows read so far only;
//   - when a rule fires, reads the book AGAIN and fills only what is still
//     offered at or better than the price the rule saw — a limit order
//     that arrived a moment late. What moved away is a miss, recorded;
//   - writes one row per (window, rule) to paper_trades (migration 0031)
//     and settles it from Kalshi's result once the window closes.
//
// WHAT IT DOES NOT DO: hold a key, sign a request, or name an order route.
// It reads public market data only. scripts/no-order-endpoints.test.mjs
// fails if any tracked file names one.
//
// Runs for PAPER_RUN_MINUTES (60) and exits 0; systemd restarts it, which
// is how new code arrives (deploy/marketslap-paper-m15.service).

import { kalshiGet } from "../lib/m15.js";
import { findEntry, parseStrategies } from "../lib/m15Backtest.js";
import { PAPER_RULES, bookRow, fillAgainst, paperPnl, paperFee, currentMarket } from "../lib/paperM15.js";
import { assertCredential } from "../lib/supabaseCredential.js";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { recorderSource } from "../lib/recorderSource.js";

const env = process.env;
const URL = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — paper_trades is private (migration 0031)"); process.exit(1); }

const SERIES = (env.PAPER_SERIES || "KXBTC15M,KXGOLD15M").split(",").map(s => s.trim()).filter(Boolean);
const SIZE = Number(env.PAPER_SIZE || 10);
const RUN_MINUTES = Number(env.PAPER_RUN_MINUTES || 60);
const POLL_MS = Number(env.PAPER_POLL_MS || 1000);
const DISCOVER_MS = Number(env.PAPER_DISCOVER_MS || 30000);
const SETTLE_MS = Number(env.PAPER_SETTLE_MS || 60000);
const SETTLE_AFTER_MS = Number(env.PAPER_SETTLE_AFTER_MS || 60000);
const SOURCE = recorderSource(env);
// PAPER_RULES_JSON overrides the tracked list, for tests and for trying a
// rule live before it earns a place in lib/paperM15.js.
const RULES = env.PAPER_RULES_JSON ? parseStrategies(env.PAPER_RULES_JSON) : PAPER_RULES;
// How far before the close any rule acts, plus a margin to build history.
const REACH = Math.max(...Object.values(RULES).map(r => (r.entry.secsMax ?? 900) + (r.entry.lookbackSecs ?? 0))) + 5;

// ── Supabase ──────────────────────────────────────────────────────────
async function rest(path, init = {}) {
  try {
    const r = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: authHeaders(KEY, { "Content-Type": "application/json", ...(init.headers || {}) }) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
  } catch (e) { return { ok: false, status: 0, body: e.message }; }
}

// Writes only while the database answers; a failure warns and the run goes on.
await assertCredential(URL, KEY, { table: "m15_quotes", unavailableIsFatal: false, log });
{
  const r = await rest("paper_trades?select=id&limit=0");
  // PostgREST answers a missing table with 404 (PGRST205); Postgres's own
  // code is 42P01. A 5xx is the database being away, not the table.
  const code = r.body && typeof r.body === "object" ? r.body.code : null;
  if (r.status === 404 || code === "PGRST205" || code === "42P01") {
    console.error("::error::table paper_trades is missing — run https://github.com/albatrossbird/housedge/blob/main/supabase/migrations/0031_paper_trades.sql");
    process.exit(1);
  }
}

// ── Kalshi ────────────────────────────────────────────────────────────
const mult = {};
for (const s of SERIES) {
  const r = await kalshiGet(`/series/${encodeURIComponent(s)}`);
  const m = Number(r.body?.series?.fee_multiplier);
  if (r.ok && Number.isFinite(m)) mult[s] = m;
  else log(`::warning::${s}: no fee_multiplier from Kalshi — not paper-trading it rather than guessing a fee`);
}
const active = SERIES.filter(s => s in mult);
if (!active.length) { console.error("::error::no series to paper-trade"); process.exit(1); }
log(`paper-trading ${active.join(", ")} | rules ${Object.keys(RULES).join(", ")} | ${SIZE} contracts | reads from ${REACH}s before each close | source ${SOURCE}`);

const stats = { reads: 0, readErrors: 0, decisions: 0, filled: 0, partial: 0, missed: 0, writeErrors: 0, settled: 0 };
const state = Object.fromEntries(active.map(s => [s, { market: null, path: [], decided: new Set(), lastDiscover: 0 }]));

async function discover(s, now) {
  const st = state[s];
  st.lastDiscover = now;
  const r = await kalshiGet(`/markets?status=open&limit=20&series_ticker=${encodeURIComponent(s)}`);
  if (!r.ok) { stats.readErrors++; return; }
  const m = currentMarket(r.body?.markets, now);
  if (m && m.ticker !== st.market?.ticker) { st.market = m; st.path = []; st.decided = new Set(); }
  if (!m) st.market = null;
}

async function decide(s, rule, hit) {
  const st = state[s], m = st.market;
  stats.decisions++;
  const t0 = Date.now();
  const again = await kalshiGet(`/markets/${encodeURIComponent(m.ticker)}/orderbook`);
  const latency = Date.now() - t0;
  const filled = again.ok ? fillAgainst(again.body, hit.side, hit.price, hit.qty) : 0;
  if (filled === hit.qty) stats.filled++; else if (filled > 0) stats.partial++; else stats.missed++;
  const row = {
    id: `${m.ticker}|${rule}`, rule, series: s, ticker: m.ticker, close_time: new Date(m.close).toISOString(),
    side: hit.side, decided_at: new Date(hit.row.t).toISOString(), decided_secs: Math.round(hit.row.secs * 10) / 10,
    decided_price: hit.price, qty_wanted: hit.qty, qty_filled: filled,
    fill_price: filled ? hit.price : null, fill_latency_ms: latency,
    fee: paperFee(hit.price, filled, mult[s]), source: SOURCE,
  };
  // ignore-duplicates: a restart mid-window must not overwrite the first decision.
  const w = await rest("paper_trades?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify([row]) });
  if (!w.ok) { stats.writeErrors++; log(`::warning::paper_trades write failed: ${w.status} ${JSON.stringify(w.body).slice(0, 160)}`); }
  log(`${rule} ${m.ticker} buy ${hit.side.toUpperCase()} ${hit.qty} @ ${hit.price} with ${hit.row.secs.toFixed(0)}s left -> ${filled ? `filled ${filled}` : "MISSED (book moved)"} in ${latency}ms`);
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const s of active) {
      const st = state[s], now = Date.now();
      if ((!st.market || now >= st.market.close) && now - st.lastDiscover >= Math.min(DISCOVER_MS, 5000)) await discover(s, now);
      else if (now - st.lastDiscover >= DISCOVER_MS) await discover(s, now);
      const m = st.market;
      if (!m) continue;
      const secs = (m.close - Date.now()) / 1000;
      if (secs > REACH || secs <= 0) continue;
      const r = await kalshiGet(`/markets/${encodeURIComponent(m.ticker)}/orderbook`);
      stats.reads++;
      if (!r.ok) { stats.readErrors++; continue; }
      const row = bookRow(r.body, Date.now(), m.close);
      if (!row) continue;
      st.path.push(row);
      for (const [name, rule] of Object.entries(RULES)) {
        if (st.decided.has(name)) continue;
        // Only the newest row is new; every earlier one was already
        // checked against this rule and did not fire.
        const hit = findEntry(rule, m, st.path, { size: SIZE, from: st.path.length - 1 });
        if (!hit) continue;
        st.decided.add(name);
        await decide(s, name, hit);
      }
    }
  } finally { busy = false; }
}

async function settle() {
  const cutoff = new Date(Date.now() - SETTLE_AFTER_MS).toISOString();
  const r = await rest(`paper_trades?select=id,ticker,side,fill_price,qty_filled,fee&result=is.null&close_time=lt.${cutoff}&limit=200`);
  if (!r.ok || !Array.isArray(r.body)) return;
  const byTicker = new Map();
  for (const t of r.body) { if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []); byTicker.get(t.ticker).push(t); }
  for (const [ticker, trades] of byTicker) {
    const m = await kalshiGet(`/markets/${encodeURIComponent(ticker)}`);
    const result = m.body?.market?.result;
    if (result !== "yes" && result !== "no") continue;     // "" while live; settles a few minutes after close
    for (const t of trades) {
      const pnl = Math.round(paperPnl(t, result) * 10000) / 10000;
      const u = await rest(`paper_trades?id=eq.${encodeURIComponent(t.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ result, pnl, settled_at: new Date().toISOString() }) });
      if (u.ok) stats.settled++; else stats.writeErrors++;
    }
  }
}

const started = Date.now();
const pollTimer = setInterval(() => tick().catch(e => log(`::warning::tick: ${e.message}`)), POLL_MS);
const settleTimer = setInterval(() => settle().catch(e => log(`::warning::settle: ${e.message}`)), SETTLE_MS);
await settle().catch(() => {});
await new Promise(res => {
  const stop = () => { clearInterval(pollTimer); clearInterval(settleTimer); res(); };
  setTimeout(stop, RUN_MINUTES * 60000);
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
});
while (busy) await new Promise(r => setTimeout(r, 50));
await settle().catch(() => {});
log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(stats)}`);
process.exit(0);
