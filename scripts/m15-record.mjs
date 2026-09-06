// Record the live price path of Kalshi's 15-minute markets.
//
// THIS IS THE HALF THAT CANNOT BE BACKFILLED. A settled market reports
// only its last price, so "what was this quoted at with seven minutes
// left" exists nowhere unless something was watching. Outcomes come
// from m15-backfill; this is the part where a day not recorded is a day
// lost for good.
//
// RUNS IN THE ACTIONS RUNNER, NOT THROUGH VERCEL. Polling every 15
// seconds is ~240 invocations an hour; against the Hobby plan's 4
// CPU-hours a month that is a day or two of budget for one day of data.
// Actions minutes are free and unmetered on a public repo, and a job
// may run for six hours, so the loop lives here and talks to Kalshi and
// Supabase directly.
import { listM15Series, kalshiGet, toM15Row, toM15Quote, quoteChanged } from "../lib/m15.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const RUN_MINUTES   = Number(process.env.M15_RUN_MINUTES || 55);
const POLL_SECONDS  = Number(process.env.M15_POLL_SECONDS || 15);
const CONCURRENCY   = Number(process.env.M15_CONCURRENCY || 6);
// A series with no open market is between windows or out of hours
// (commodities and FX do not trade at 4am Sunday). Re-checking it every
// tick is wasted requests at an API that rate-limits datacenter IPs, so
// a dry series is rested — but only briefly, because a 15-minute market
// that is missed is missed entirely.
const IDLE_RECHECK_MS = Number(process.env.M15_IDLE_RECHECK_MS || 120000);

if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and a key are required"); process.exit(1); }
console.log(`credential: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon (writes will be REJECTED by RLS)"}`);

async function post(table, rows, onConflict) {
  if (!rows.length) return true;
  const url = `${SUPABASE_URL}/rest/v1/${table}` + (onConflict ? `?on_conflict=${onConflict}` : "");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Prefer: onConflict ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) { console.log(`::warning::${table} write ${r.status}: ${(await r.text()).slice(0, 200)}`); return false; }
  return true;
}

const { series, errors } = await listM15Series();
errors.forEach(e => console.log(`::warning::series list: ${e}`));
if (!series.length) { console.error("::error::no 15-minute series found"); process.exit(1); }
console.log(`watching ${series.length} series, every ${POLL_SECONDS}s for ${RUN_MINUTES}m`);

const lastQuote = new Map();   // ticker -> last row WRITTEN, for write-on-change
const idleUntil = new Map();   // series -> ms timestamp
const stats = { ticks: 0, polls: 0, quotes: 0, markets: 0, errors: 0, seriesSeen: new Set() };

const deadline = Date.now() + RUN_MINUTES * 60000;

async function pollSeries(ticker) {
  const r = await kalshiGet(`/markets?status=open&limit=20&series_ticker=${encodeURIComponent(ticker)}`);
  stats.polls++;
  if (!r.ok) { stats.errors++; return { quotes: [], markets: [] }; }
  const open = r.body.markets || [];
  if (!open.length) { idleUntil.set(ticker, Date.now() + IDLE_RECHECK_MS); return { quotes: [], markets: [] }; }
  idleUntil.delete(ticker);
  stats.seriesSeen.add(ticker);

  const now = Date.now();
  const quotes = [], markets = [];
  for (const m of open) {
    const q = toM15Quote(m, now);
    if (q && quoteChanged(lastQuote.get(m.ticker), q)) { quotes.push(q); lastQuote.set(m.ticker, q); }
    // The market record is upserted alongside, so a window we watched
    // live is already present before the backfill ever sees it settle.
    const row = toM15Row(m, ticker);
    if (row) markets.push(row);
  }
  return { quotes, markets };
}

while (Date.now() < deadline) {
  const tickStart = Date.now();
  const due = series.map(s => s.ticker).filter(t => (idleUntil.get(t) || 0) <= tickStart);

  const quotes = [], markets = [];
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    for (const res of await Promise.all(batch.map(pollSeries))) {
      quotes.push(...res.quotes); markets.push(...res.markets);
    }
  }

  if (quotes.length) { if (await post("m15_quotes", quotes)) stats.quotes += quotes.length; }
  if (markets.length) { if (await post("m15_markets", markets, "ticker")) stats.markets += markets.length; }

  stats.ticks++;
  if (stats.ticks % 20 === 0) {
    console.log(`t=${stats.ticks} polls=${stats.polls} quotes=${stats.quotes} live=${stats.seriesSeen.size}/${series.length} errors=${stats.errors}`);
  }

  const elapsed = Date.now() - tickStart;
  await new Promise(r => setTimeout(r, Math.max(0, POLL_SECONDS * 1000 - elapsed)));
}

console.log(`\nticks=${stats.ticks} polls=${stats.polls} quotesWritten=${stats.quotes} marketsSeen=${stats.markets} seriesLive=${stats.seriesSeen.size}/${series.length} errors=${stats.errors}`);
console.log(`live series: ${[...stats.seriesSeen].sort().join(" ") || "(none)"}`);

// A recorder that records nothing is the failure this whole area is
// about. Crypto's 15-minute series run 24/7, so zero quotes over a full
// run means the recorder is broken, not that the market was quiet.
if (stats.quotes === 0) { console.error("::error::no quotes written across the whole run"); process.exit(1); }
if (stats.errors > stats.polls / 2) { console.error(`::error::${stats.errors} of ${stats.polls} polls failed`); process.exit(1); }
