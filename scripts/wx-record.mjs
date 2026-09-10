// Record Kalshi's daily temperature ladders, and the NWS forecast they
// will be judged against.
//
// TWO THINGS, RECORDED TOGETHER ON PURPOSE. The book alone cannot tell
// you whether a price was wrong; the forecast alone cannot tell you
// whether anyone disagreed. The question this dataset exists to answer
// — was Kalshi mispriced relative to what was knowable at the time —
// needs both, timestamped, from before the outcome was known.
//
// Neither half can be backfilled. Kalshi's settled market reports one
// last price, and NWS publishes the CURRENT forecast, not the forecast
// it was issuing yesterday afternoon. A day not recorded is gone.
//
// RUNS IN THE ACTIONS RUNNER, like m15-record and for the same reason:
// a polling loop against Vercel's 4 CPU-hours a month is a day of data
// for a month of budget, and Actions minutes are free on a public repo.
import {
  WEATHER_CATEGORY, CLI_TO_STATION, kalshiGet, cliFromRules,
  toWxMarketRow, toWxQuote, quoteChanged, nwsForecast,
} from "../lib/weather.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const RUN_MINUTES  = Number(process.env.WX_RUN_MINUTES || 330);
const POLL_MINUTES = Number(process.env.WX_POLL_MINUTES || 10);
// The forecast moves far more slowly than the book — NWS issues a few
// times a day — so re-asking every tick is requests spent for nothing.
const FORECAST_EVERY_MINUTES = Number(process.env.WX_FORECAST_MINUTES || 60);

if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and a key are required"); process.exit(1); }
console.log(`credential: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon (writes will be REJECTED by RLS)"}`);

async function post(table, rows, onConflict) {
  if (!rows.length) return { ok: true, n: 0 };
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
  if (!r.ok) return { ok: false, n: 0, err: `${r.status} ${(await r.text()).slice(0, 180)}` };
  return { ok: true, n: rows.length };
}

// Which series to watch. Discovered, not hardcoded: Kalshi adds cities,
// and a hand-written list is the bug this repo has already fixed twice
// (KALSHI_SERIES in refresh, the four soccer tickers in discovery).
async function dailyTempSeries() {
  const all = (await kalshiGet("/series")).series || [];
  return all
    .filter(s => s.category === WEATHER_CATEGORY)
    .filter(s => /HIGH|LOW/.test(String(s.ticker || "").toUpperCase()))
    .map(s => s.ticker);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const deadline = Date.now() + RUN_MINUTES * 60000;
const lastQuote = new Map();      // ticker -> last written quote
let ticks = 0, quotesWritten = 0, marketsSeen = 0, forecastsWritten = 0;
let lastForecastAt = 0;
const errors = [];
const skippedNoStation = new Set();   // series with no CLI in their rules — not daily markets

const series = await dailyTempSeries();
console.log(`watching ${series.length} daily temperature series for ${RUN_MINUTES} min, polling every ${POLL_MINUTES} min`);

while (Date.now() < deadline) {
  ticks++;
  const tickStart = Date.now();
  const marketRows = [], quoteRows = [];
  const stations = new Set();
  let live = 0;

  for (const s of series) {
    let ms = [];
    try {
      ms = (await kalshiGet(`/markets?status=open&limit=200&series_ticker=${encodeURIComponent(s)}`)).markets || [];
    } catch (err) { errors.push(`${s}: ${err.message}`.slice(0, 120)); continue; }
    if (!ms.length) continue;
    live++;

    // The settlement station is stated in the RULES, not derivable from
    // the series ticker — KXHIGHMIA and KXHIGHTMIN follow no single
    // convention. Read once per series from its first market.
    const cli = cliFromRules(ms[0].rules_primary);

    // No CLI station in the rules means this is not a daily
    // station-settled temperature market, and storing it would be
    // WORSE than skipping it. KXSJCLOWT asks whether San Jose drops
    // below 40F at any hour in ALL of December, and its ticker is
    // KXSJCLOWT-26DEC31-40 — so targetDateOf reads it as a Dec 31
    // DAILY market and any calibration built on this table would
    // compare a month-long claim against one day's forecast.
    //
    // Reported by name rather than as an error, like embedGate and
    // kalshiSeriesFailed: a series that is correctly skipped every run
    // is an alarm nobody can clear, which teaches you to ignore the
    // ones that matter.
    if (!cli) { skippedNoStation.add(s); continue; }

    if (CLI_TO_STATION[cli]) stations.add(CLI_TO_STATION[cli]);
    else errors.push(`unmapped station ${cli} (${s}) — add it to CLI_TO_STATION`);

    for (const m of ms) {
      marketsSeen++;
      marketRows.push(toWxMarketRow(m, { series: s, cli }));
      const q = toWxQuote(m, tickStart);
      if (quoteChanged(lastQuote.get(m.ticker), q)) { quoteRows.push(q); lastQuote.set(m.ticker, q); }
    }
    await sleep(400);   // Kalshi rate-limits datacenter IPs.
  }

  const mw = await post("wx_markets", marketRows, "ticker");
  if (!mw.ok) errors.push(`wx_markets write: ${mw.err}`);
  const qw = await post("wx_quotes", quoteRows);
  if (!qw.ok) errors.push(`wx_quotes write: ${qw.err}`); else quotesWritten += qw.n;

  // The forecast, on its own slower clock.
  if (Date.now() - lastForecastAt >= FORECAST_EVERY_MINUTES * 60000) {
    lastForecastAt = Date.now();
    const fRows = [];
    for (const st of stations) {
      try {
        // Only days a market could exist for. The 7-day feed would
        // otherwise store five days nobody is trading.
        const rows = (await nwsForecast(st)).filter(r => r.high_f != null || r.low_f != null).slice(0, 3);
        fRows.push(...rows.map(r => ({ ...r, observed_at: new Date().toISOString() })));
      } catch (err) { errors.push(`nws ${st}: ${err.message}`.slice(0, 120)); }
      await sleep(600);
    }
    const fw = await post("wx_forecasts", fRows);
    if (!fw.ok) errors.push(`wx_forecasts write: ${fw.err}`); else forecastsWritten += fw.n;
    console.log(`  tick ${ticks}: ${live} live series, ${marketRows.length} markets, +${qw.n} quotes, +${fw.n} forecasts (${stations.size} stations)`);
  } else {
    console.log(`  tick ${ticks}: ${live} live series, ${marketRows.length} markets, +${qw.n} quotes`);
  }

  const spent = Date.now() - tickStart;
  const wait = Math.max(0, POLL_MINUTES * 60000 - spent);
  if (Date.now() + wait >= deadline) break;
  await sleep(wait);
}

console.log(`\nticks=${ticks} marketsSeen=${marketsSeen} quotesWritten=${quotesWritten} forecastsWritten=${forecastsWritten} errors=${errors.length}`);
if (skippedNoStation.size)
  console.log(`skipped (no settlement station in rules, not daily markets): ${[...skippedNoStation].join(", ")}`);
for (const e of errors.slice(0, 10)) console.log(`::warning::${e}`);

// A run that wrote NOTHING is a broken run, not a quiet one — the
// silent no-op this repo keeps being rewritten to stop. Weather markets
// exist every day, so zero is never correct here.
if (!quotesWritten && !forecastsWritten) {
  console.error("::error::recorded nothing at all — check the credential and Kalshi's weather series");
  process.exit(1);
}
