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
import { listM15Series, kalshiGet, toM15Row, toM15Quote, quoteChanged, marketChanged, bookDepth } from "../lib/m15.js";
import { assertCredential } from "../lib/supabaseCredential.js";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { recorderSource } from "../lib/recorderSource.js";

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
// Which recorder this is, and why it is derived rather than set in
// the unit file: lib/recorderSource.js. That module exists because an
// M15_SOURCE in the systemd unit could never reach the box.
const SOURCE = recorderSource(process.env, "M15_SOURCE");
console.log(`source: ${SOURCE}`);

if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and a key are required"); process.exit(1); }
console.log(`credential: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon (writes will be REJECTED by RLS)"}`);

// Proven, not assumed — the line above reports which VARIABLE IS SET
// and says nothing about whether the value works. See the module.
await assertCredential(SUPABASE_URL, KEY, { table: "m15_quotes" });

// OPTIONAL COLUMNS, each added by a hand-run migration that a deploy can
// land before — the same case migration 0004 handles in the price path.
// When the database rejects one, the recorder drops that group and keeps
// recording rather than losing a window it can never get back: an
// unattributed or depth-less row is a worse reading, a missing one is a
// hole.
//
// SCOPED TO m15_quotes. The weather recorder learned this the hard way —
// an unscoped strip there would have removed a NOT NULL column from a
// different table in reaction to a missing one here. Only m15_quotes
// carries these, so only m15_quotes is ever stripped.
const OPTIONAL = [
  { name: "source", migration: "0023_m15_quotes_source.sql", cols: ["source"] },
  { name: "depth",  migration: "0027_m15_quotes_depth.sql",
    cols: ["book_bid", "book_ask", "bid_depth_1c", "bid_depth_3c", "bid_depth_5c",
           "ask_depth_1c", "ask_depth_3c", "ask_depth_5c"] },
];
const unsupported = new Set();   // group names the database has refused
const STAMPED = "m15_quotes";

function strip(rows) {
  const drop = OPTIONAL.filter(g => unsupported.has(g.name)).flatMap(g => g.cols);
  if (!drop.length) return rows;
  return rows.map(r => { const o = { ...r }; for (const c of drop) delete o[c]; return o; });
}

async function post(table, rows, onConflict) {
  if (!rows.length) return true;
  if (table === STAMPED) rows = strip(rows);
  const url = `${SUPABASE_URL}/rest/v1/${table}` + (onConflict ? `?on_conflict=${onConflict}` : "");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(KEY),
      "Content-Type": "application/json",
      Prefer: onConflict ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    // PGRST204 / 42703: the column is not there. Say which migration
    // adds it — "could not find the 'source' column" on its own sends
    // the next reader looking through the recorder rather than the
    // schema — then retry without it, once.
    if (table === STAMPED && /PGRST204|42703|column/.test(body)) {
      // Which group is missing is read from the error, which names the
      // column. A body naming none of ours is a real failure and falls
      // through to be reported as one.
      // Word-boundary, not quote-shaped: PostgREST writes 'book_bid' while
      // Postgres's own 42703 writes "book_bid", which reaches us
      // JSON-escaped as \"book_bid\" and matches neither quoted form.
      const g = OPTIONAL.find(g => !unsupported.has(g.name) && g.cols.some(c => new RegExp(`\\b${c}\\b`).test(body)));
      if (g) {
        unsupported.add(g.name);
        console.log(`::warning::${table}: no '${g.name}' columns — run migration ${g.migration}. Recording WITHOUT ${g.name} until then.`);
        return post(table, rows, onConflict);
      }
    }
    console.log(`::warning::${table} write ${r.status}: ${body.slice(0, 200)}`);
    return false;
  }
  return true;
}

const { series, errors } = await listM15Series();
errors.forEach(e => console.log(`::warning::series list: ${e}`));
if (!series.length) { console.error("::error::no 15-minute series found"); process.exit(1); }
console.log(`watching ${series.length} series, every ${POLL_SECONDS}s for ${RUN_MINUTES}m`);

const lastQuote = new Map();   // ticker -> last row WRITTEN, for write-on-change
const lastMarket = new Map();  // same, for the upserted market row — see marketChanged
const idleUntil = new Map();   // series -> ms timestamp
const stats = { ticks: 0, polls: 0, quotes: 0, markets: 0, errors: 0, books: 0, bookErrors: 0, seriesSeen: new Set() };

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
    const q = toM15Quote(m, now, SOURCE);
    if (!q) continue;
    // THE BOOK IS READ EVERY TICK, BECAUSE THE LIST IS CACHED.
    //
    // The /markets list this loop polls is served by CloudFront with
    // `cache-control: public, max-age=15` — measured 2026-09-26, `x-cache:
    // Hit from cloudfront, age=2`. Fired at the same instant, the list
    // agreed with the live book on 1 read in 48, and on KXETH15M it quoted
    // 0.68/0.69 while the book stood at 0.53/0.54. Every yes_bid/yes_ask
    // this recorder has ever stored came through that cache.
    //
    // `/orderbook` is not cached (`x-cache: Miss`) and it IS the market —
    // the resting orders themselves, not a summary of them. So its touch,
    // book_bid/book_ask, is the executable price, and a change in it makes
    // a row new just as a change in the list's price does. Reading the
    // book only for rows the stale list had already decided to write
    // would sample the truth at moments chosen by the cache.
    //
    // yes_bid/yes_ask keep their source so the recorded history stays
    // like-for-like; a column that silently changed meaning mid-series
    // would corrupt every backtest that spans the change.
    //
    // A failed book read costs the depth, NEVER the quote: bookDepth
    // returns every field null, which the columns document as "not
    // fetched", and the price path is written regardless.
    const ob = await kalshiGet(`/markets/${encodeURIComponent(m.ticker)}/orderbook`);
    stats.books++;
    if (!ob.ok) stats.bookErrors++;
    Object.assign(q, bookDepth(ob.ok ? ob.body : null));
    if (quoteChanged(lastQuote.get(m.ticker), q)) { quotes.push(q); lastQuote.set(m.ticker, q); }
    // The market record is upserted alongside, so a window we watched
    // live is already present before the backfill ever sees it settle.
    // Gated on change like the quote is: this is an UPDATE of a hot row
    // rather than an append, so writing it every tick costs far more IO
    // than the quotes do and buys freshness nothing reads.
    const row = toM15Row(m, ticker);
    if (row && marketChanged(lastMarket.get(m.ticker), row)) {
      markets.push(row); lastMarket.set(m.ticker, row);
    }
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
    console.log(`t=${stats.ticks} polls=${stats.polls} quotes=${stats.quotes} books=${stats.books} bookErrors=${stats.bookErrors} live=${stats.seriesSeen.size}/${series.length} errors=${stats.errors}`);
  }

  const elapsed = Date.now() - tickStart;
  await new Promise(r => setTimeout(r, Math.max(0, POLL_SECONDS * 1000 - elapsed)));
}

console.log(`\nticks=${stats.ticks} polls=${stats.polls} quotesWritten=${stats.quotes} marketsSeen=${stats.markets} seriesLive=${stats.seriesSeen.size}/${series.length} errors=${stats.errors} books=${stats.books} bookErrors=${stats.bookErrors}`);
// Depth failing is LOUD but not fatal. Exiting would restart the unit
// and cost price path to protect depth, which is the wrong way round —
// but a run where most book reads failed is one whose depth columns are
// mostly null, and that must not pass quietly as a healthy run.
if (stats.books && stats.bookErrors > stats.books / 2)
  console.log(`::warning::${stats.bookErrors} of ${stats.books} orderbook reads failed — depth columns are mostly null this run`);
console.log(`live series: ${[...stats.seriesSeen].sort().join(" ") || "(none)"}`);

// A recorder that records nothing is the failure this whole area is
// about. Crypto's 15-minute series run 24/7, so zero quotes over a full
// run means the recorder is broken, not that the market was quiet.
if (stats.quotes === 0) { console.error("::error::no quotes written across the whole run"); process.exit(1); }
if (stats.errors > stats.polls / 2) { console.error(`::error::${stats.errors} of ${stats.polls} polls failed`); process.exit(1); }
