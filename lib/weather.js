// Kalshi's daily temperature markets, and the NWS forecast they get
// compared against.
//
// Deliberately mirrors lib/m15.js — same shape of problem, same shape
// of solution — but the two are NOT merged. A 15-minute crypto market
// and a daily temperature market look alike and are not: the
// temperature one has a PUBLIC FORECAST available a day ahead, which is
// the entire reason it might be mispriced, and that forecast has to be
// fetched and stored alongside the book.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const NWS = "https://api.weather.gov";

// NWS asks for a contactable User-Agent and returns 403 without one.
const NWS_UA = "marketslap.com weather research (https://marketslap.com)";

export const WEATHER_CATEGORY = "Climate and Weather";

// Kalshi names the settlement station by its CLIMATE PRODUCT (CLIMIA),
// NWS addresses it by ICAO (KMIA). Every pair below was resolved
// against /stations/<icao> and matched the expected city — the first
// 16 on 2026-09-09, the rest on 2026-09-10 after a live run named them.
//
// A map rather than a rule, because the two are not derivable from one
// another: CLINYC is Central Park (KNYC), not any of the three New York
// airports, and Minneapolis files under CLIMSP for KMSP.
//
// **Which airport a city settles at is not the obvious one.** Kalshi's
// Chicago market is CLIMDW (MIDWAY) and its Houston market is CLIHOU
// (HOBBY) — not O'Hare and not Intercontinental. CLIORD/CLIIAH are
// correct CLI->ICAO facts and are kept for the day Kalshi lists them,
// but NO live series uses either. Reading Chicago's forecast off KORD
// would be a different airport's weather, and Midway and O'Hare
// routinely differ by a degree or two — which is the whole size of the
// edge this table exists to find.
//
// **Settlement is The Weather Company, not NWS.** Every daily rules
// string reads "according to The Weather Company". NWS is the free,
// public forecast we compare against, so the TWC/NWS basis is itself a
// risk to be measured, not a detail — do not treat an NWS observation
// as the settled value.
export const CLI_TO_STATION = {
  CLIMIA: "KMIA", CLIMSP: "KMSP", CLIDFW: "KDFW", CLIDEN: "KDEN",
  CLIATL: "KATL", CLIDCA: "KDCA", CLINYC: "KNYC", CLISEA: "KSEA",
  CLIAUS: "KAUS", CLIPHL: "KPHL", CLIIAH: "KIAH", CLITTN: "KTTN",
  CLIORD: "KORD", CLILAX: "KLAX", CLIPHX: "KPHX", CLIBOS: "KBOS",
  CLIEWR: "KEWR", CLIHOU: "KHOU", CLILAS: "KLAS", CLIMDW: "KMDW",
  CLIMSY: "KMSY", CLIOKC: "KOKC", CLISAN: "KSAN", CLISAT: "KSAT",
  CLISDF: "KSDF", CLISFO: "KSFO",
};

export async function kalshiGet(path, { attempts = 4, fetchImpl = fetch } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchImpl(`${KALSHI}${path}`, { headers: { "User-Agent": "marketslap/1.0" } });
      if (r.status === 429) {
        // Kalshi rate-limits datacenter IPs. Honour Retry-After, then
        // back off — three tries 400ms apart is not a retry against a
        // throttle, it is three more requests into it.
        const wait = Number(r.headers.get("retry-after")) * 1000 || 1500 * (i + 1);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) throw new Error(`kalshi ${r.status} ${path.slice(0, 60)}`);
      return await r.json();
    } catch (err) { last = err; await new Promise(res => setTimeout(res, 800 * (i + 1))); }
  }
  throw last || new Error(`kalshi failed ${path.slice(0, 60)}`);
}

export async function nwsGet(path, { attempts = 3, fetchImpl = fetch } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchImpl(`${NWS}${path}`, {
        headers: { "User-Agent": NWS_UA, Accept: "application/geo+json" },
      });
      if (!r.ok) throw new Error(`nws ${r.status} ${path.slice(0, 50)}`);
      return await r.json();
    } catch (err) { last = err; await new Promise(res => setTimeout(res, 1200 * (i + 1))); }
  }
  throw last || new Error(`nws failed ${path.slice(0, 50)}`);
}

// The CLI code out of Kalshi's own rules text, which is where the
// settlement station is actually stated. Read from the rules rather
// than guessed from the series ticker: KXHIGHMIA and KXHIGHTMIN do not
// follow one convention, and the rules are authoritative.
export function cliFromRules(rules) {
  const m = /\(([A-Z]{3,8})\)/.exec(String(rules || ""));
  return m ? m[1] : null;
}

// The DAY being forecast, which is not close_time — a market for Sep 10
// closes at 05:00Z on Sep 11, so taking the close date is off by one on
// every single market.
//
// Kalshi puts the date in the ticker: KXHIGHMIA-26SEP10-B90.5.
const TICKER_DATE = /-(\d{2})([A-Z]{3})(\d{2})-/;
const MONTHS = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
                 JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
export function targetDateOf(ticker) {
  const m = TICKER_DATE.exec(String(ticker || "").toUpperCase());
  if (!m) return null;
  const mm = MONTHS[m[2]];
  return mm ? `20${m[1]}-${mm}-${m[3]}` : null;
}

const num = v => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));

export function toWxMarketRow(m, { series, cli }) {
  return {
    ticker: m.ticker,
    series,
    event_ticker: m.event_ticker || null,
    station: cli ? (CLI_TO_STATION[cli] || null) : null,
    cli: cli || null,
    title: m.title || m.yes_sub_title || null,
    strike_type: m.strike_type || null,
    // Kalshi's own boundary fields, NOT the parsed subtitle. "94° or
    // above" is a rendering; floor_strike is the number it renders.
    floor_strike: num(m.floor_strike),
    cap_strike: num(m.cap_strike),
    target_date: targetDateOf(m.ticker),
    close_time: m.close_time || null,
    // "" on a live market, not null — the same trap m15 hit. An empty
    // string stored as-is makes every open market look settled with a
    // blank outcome.
    result: m.result === "yes" || m.result === "no" ? m.result : null,
    last_price: num(m.last_price),
    volume: num(m.volume_fp),
    open_interest: num(m.open_interest_fp),
    updated_at: new Date().toISOString(),
  };
}

export function toWxQuote(m, now = Date.now()) {
  const close = m.close_time ? Date.parse(m.close_time) : NaN;
  return {
    ticker: m.ticker,
    observed_at: new Date(now).toISOString(),
    hours_to_close: isFinite(close) ? Math.round(((close - now) / 3600000) * 100) / 100 : null,
    yes_bid: num(m.yes_bid_dollars),
    yes_ask: num(m.yes_ask_dollars),
    // Kalshi publishes size on these; null is UNKNOWN and must never
    // be coerced to 0 — Number(null) is 0 and a fabricated zero reads
    // as "nothing offered", which is a claim about the book rather
    // than about our data.
    bid_size: num(m.yes_bid_size_fp),
    ask_size: num(m.yes_ask_size_fp),
    volume: num(m.volume_fp),
  };
}

// Write-on-change with a heartbeat, like m15. Unconditional rows would
// be mostly duplicates; the heartbeat is what keeps a flat market
// distinguishable from a stopped recorder.
export function quoteChanged(prev, q, { heartbeatMs = 900000 } = {}) {
  if (!prev) return true;
  if (Date.parse(q.observed_at) - Date.parse(prev.observed_at) >= heartbeatMs) return true;
  return prev.yes_bid !== q.yes_bid || prev.yes_ask !== q.yes_ask
      || prev.bid_size !== q.bid_size || prev.ask_size !== q.ask_size;
}

const cToF = c => (c == null ? null : Math.round(((c * 9) / 5 + 32) * 10) / 10);

// The NWS forecast for one station, as daily highs and lows keyed by
// the date they apply to.
//
// Read from the twice-daily PERIOD forecast rather than the gridded
// feed: the periods are what NWS actually publishes as "the high for
// Thursday", which is the quantity Kalshi's market is about. The grid
// carries hourly maxima that need reassembling into a local calendar
// day, and getting that wrong by one hour is a whole bucket.
export async function nwsForecast(station, { fetchImpl = fetch } = {}) {
  const st = await nwsGet(`/stations/${encodeURIComponent(station)}`, { fetchImpl });
  const [lon, lat] = st?.geometry?.coordinates || [];
  if (lat == null || lon == null) throw new Error(`no coordinates for ${station}`);

  const pt = await nwsGet(`/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { fetchImpl });
  const url = pt?.properties?.forecast;
  if (!url) throw new Error(`no forecast url for ${station}`);

  const fc = await nwsGet(url.replace(NWS, ""), { fetchImpl });
  const out = new Map();
  for (const p of fc?.properties?.periods || []) {
    const date = String(p.startTime || "").slice(0, 10);
    if (!date) continue;
    const f = p.temperatureUnit === "F" ? Number(p.temperature) : cToF(Number(p.temperature));
    const row = out.get(date) || { station, target_date: date, source: "nws", high_f: null, low_f: null, short_forecast: null };
    // isDaytime is what separates a high from a low. A period without
    // it is skipped rather than guessed at.
    if (p.isDaytime === true) { row.high_f = f; row.short_forecast = p.shortForecast || null; }
    else if (p.isDaytime === false) { row.low_f = f; }
    out.set(date, row);
  }
  return [...out.values()];
}
