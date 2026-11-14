// Ladder consistency on Kalshi's crypto strike markets.
// The plan, fixed before the run: docs/research/ladder-plan.md.
//
//   node scripts/ladder-tape.mjs --size-pass [--since=2026-10-30] [--until=2026-11-13]
//
// --size-pass reads only the series list and the markets: no tape, no
// candles. It finds the series from /series?category=Crypto (hourly,
// daily and 15-minute), groups every market that closed in the window by
// (settlement index, close), counts the implication pairs, and reports
// the volume and the number of tape and candle requests the full read
// would need. The plan's early stop is checked here: under 1,000 ladder
// contracts a day, stop.
//
// Public endpoints only, no key, no Supabase. Kalshi holds an IP to about
// 5 requests a second, so requests are paced (--pace, ms).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settlementIndex, eventOf, groupKey, implicationPairs, seriesOfTicker } from "../lib/ladder.js";

const B = "https://api.elections.kalshi.com/trade-api/v2";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SINCE = Date.parse(`${opt("since", "2026-10-30")}T00:00:00Z`);
const UNTIL = Date.parse(`${opt("until", "2026-11-13")}T00:00:00Z`);
const PACE = Number(opt("pace", 220));
const OUT = opt("out", ".ladder-cache");
const DAYS = (UNTIL - SINCE) / 86400000;
const FREQS = new Set(["hourly", "daily", "fifteen_min"]);
const LADDER_FREQS = new Set(["hourly", "daily"]);
const EARLY_STOP_PER_DAY = 1000; // contracts, from the plan
const CANDLES_PER_REQUEST = 10000;
const TRADES_PER_PAGE = 1000;

if (!process.argv.includes("--size-pass")) {
  console.error("Only --size-pass exists so far. The tape read is written after its size is shown (see the plan).");
  process.exit(2);
}
if (!(SINCE < UNTIL)) { console.error("::error::--since must be before --until"); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let requests = 0, nextAt = 0;
async function get(path) {
  for (let i = 0; i < 6; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); requests++;
    const r = await fetch(B + path);
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i);
      continue;
    }
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 6 tries`);
}

const cutoff = await get("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts);
if (!(SINCE >= marketCut)) {
  console.error(`::error::the window starts before the live tier (${cutoff.market_settled_ts}); this script reads /markets only`);
  process.exit(1);
}

const { series } = await get("/series?category=Crypto");
const picked = series.filter(s => FREQS.has(s.frequency)).sort((a, b) => a.ticker.localeCompare(b.ticker));
console.log(`series: ${series.length} in Crypto, ${picked.length} hourly/daily/15-minute`);

const markets = [];
const perSeries = new Map();
const excluded = new Map(); // series -> { count, why, example }
for (const s of picked) {
  let cursor = "", n = 0;
  do {
    const q = `/markets?series_ticker=${s.ticker}&min_close_ts=${SINCE / 1000}&max_close_ts=${UNTIL / 1000 - 1}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await get(q);
    for (const m of page.markets || []) {
      n++;
      const close = Date.parse(m.close_time);
      if (!(close >= SINCE && close < UNTIL)) continue;
      const idx = settlementIndex(m.rules_primary), ev = eventOf(m);
      if (!idx || !ev) {
        const e = excluded.get(s.ticker) || { count: 0, why: !idx ? "rules not the 60-second CF average" : `strike_type ${m.strike_type}`, example: (m.rules_primary || "").slice(0, 160) };
        e.count++; excluded.set(s.ticker, e);
        continue;
      }
      markets.push({
        ticker: m.ticker, series: s.ticker, freq: s.frequency, group: groupKey(m), ev,
        open: Date.parse(m.open_time), close, volume: Number(m.volume_fp ?? m.volume ?? 0),
        floor: m.floor_strike ?? null, expiration: m.expiration_value ?? null,
      });
    }
    cursor = page.cursor || "";
  } while (cursor);
  perSeries.set(s.ticker, { freq: s.frequency, listed: n, fee: `${s.fee_type} x${s.fee_multiplier}` });
}

// Fee schedule changes inside the window, per series that has markets.
const seriesWithMarkets = [...new Set(markets.map(m => m.series))];
const feeChanges = [];
for (const s of seriesWithMarkets) {
  const r = await get(`/series/fee_changes?series_ticker=${s}&show_historical=true`);
  for (const c of r.series_fee_change_arr || r.fee_changes || []) {
    const t = Date.parse(c.scheduled_ts || c.effective_ts || c.created_ts || "");
    if (t >= SINCE - 30 * 86400000) feeChanges.push({ series: s, ...c });
  }
}

// Groups, pairs, and which pairs could ever print (both legs traded).
const groups = new Map();
for (const m of markets) { if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }
const byTicker = new Map(markets.map(m => [m.ticker, m]));
let pairCount = 0, livePairs = 0, crossSeriesLive = 0, multiGroups = 0;
const needTape = new Set();
const livePairsBySeries = new Map();
for (const [, ms] of groups) {
  if (ms.length < 2) continue;
  multiGroups++;
  for (const [x, y] of implicationPairs(ms)) {
    pairCount++;
    const a = byTicker.get(x), b = byTicker.get(y);
    if (!(a.volume > 0 && b.volume > 0)) continue;
    livePairs++; needTape.add(x); needTape.add(y);
    if (a.series !== b.series) crossSeriesLive++;
    const k = [a.series, b.series].sort().join(" ~ ");
    livePairsBySeries.set(k, (livePairsBySeries.get(k) || 0) + 1);
  }
}

// Volume per UTC day of close: the ladders (hourly + daily series) are
// what the early stop is about; the 15-minute markets are reported apart.
const day = t => new Date(t).toISOString().slice(0, 10);
const volDay = new Map();
for (const m of markets) {
  const d = day(m.close), v = volDay.get(d) || { ladder: 0, m15: 0 };
  if (LADDER_FREQS.has(m.freq)) v.ladder += m.volume; else v.m15 += m.volume;
  volDay.set(d, v);
}
const ladderPerDay = [...volDay.values()].reduce((s, v) => s + v.ladder, 0) / DAYS;

// Request sizes for the full read, over the markets in a live pair only.
let candleMinutes = 0, tapeVolume = 0;
for (const t of needTape) {
  const m = byTicker.get(t);
  candleMinutes += Math.max(1, Math.ceil((m.close - m.open) / 60000));
  tapeVolume += m.volume;
}

// 15-minute strike check: a window's floor_strike should be the previous
// window's settlement average, or a 15-minute market's event is not what
// its strike says. Compared on consecutive windows of each series.
const strikeCheck = { compared: 0, equal: 0, maxGap: 0 };
for (const s of new Set(markets.filter(m => m.freq === "fifteen_min").map(m => m.series))) {
  const ws = markets.filter(m => m.series === s).sort((a, b) => a.close - b.close);
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].close - ws[i - 1].close !== 15 * 60000 || ws[i - 1].expiration == null || ws[i].floor == null) continue;
    const gap = Math.abs(Number(ws[i].floor) - Number(ws[i - 1].expiration));
    strikeCheck.compared++;
    if (gap < 1e-6) strikeCheck.equal++; // float noise only: 9e-7 seen live
    strikeCheck.maxGap = Math.max(strikeCheck.maxGap, gap);
  }
}

// ---- report ----
const fmt = n => Math.round(n).toLocaleString("en-US");
console.log(`window ${day(SINCE)} .. ${day(UNTIL - 1)} (${DAYS} days), live tier from ${cutoff.market_settled_ts}`);
console.log(`\nper series (markets closing in the window):`);
const counts = new Map();
for (const m of markets) {
  const c = counts.get(m.series) || { n: 0, traded: 0, vol: 0 };
  c.n++; if (m.volume > 0) c.traded++; c.vol += m.volume; counts.set(m.series, c);
}
for (const [s, info] of perSeries) {
  const c = counts.get(s), x = excluded.get(s);
  if (!c && !x) continue;
  console.log(`  ${info.freq.padEnd(11)} ${s.padEnd(18)} markets ${String(c?.n || 0).padStart(6)}  traded ${String(c?.traded || 0).padStart(6)}  contracts ${fmt(c?.vol || 0).padStart(13)}  ${info.fee}${x ? `  EXCLUDED ${x.count} (${x.why})` : ""}`);
}
for (const [s, x] of excluded) if (!counts.get(s)) console.log(`  excluded ${s}: ${x.count}, ${x.why}: "${x.example}"`);
console.log(`\nfee changes inside or near the window: ${feeChanges.length ? JSON.stringify(feeChanges) : "none"}`);
console.log(`\ngroups (index + close) with 2+ markets: ${fmt(multiGroups)} of ${fmt(groups.size)}`);
console.log(`implication pairs: ${fmt(pairCount)}; with both legs traded: ${fmt(livePairs)} (${fmt(crossSeriesLive)} across two series)`);
console.log(`live pairs by series:`);
for (const [k, v] of [...livePairsBySeries].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(v).padStart(8)}  ${k}`);
console.log(`\ncontracts per UTC day (by close):`);
for (const [d, v] of [...volDay].sort()) console.log(`  ${d}  ladders ${fmt(v.ladder).padStart(13)}   15-minute ${fmt(v.m15).padStart(13)}`);
console.log(`ladder contracts a day, mean: ${fmt(ladderPerDay)}`);
console.log(`\n15-minute strikes against the previous window's settlement: ${strikeCheck.equal} of ${strikeCheck.compared} within 1e-6, largest gap ${strikeCheck.maxGap}`);
console.log(`\nfull read, markets in a live pair only: ${fmt(needTape.size)} markets, ${fmt(tapeVolume)} contracts traded`);
console.log(`  tape: at least ${fmt(needTape.size)} requests (one per market), plus one per ${TRADES_PER_PAGE} trades; the trade count is not known until read`);
console.log(`  candles: ${fmt(candleMinutes)} market-minutes, about ${fmt(Math.ceil(candleMinutes / CANDLES_PER_REQUEST))} requests at ${CANDLES_PER_REQUEST} a request`);
console.log(`  at ~${(1000 / PACE).toFixed(1)} requests a second the floor is ~${fmt((needTape.size + candleMinutes / CANDLES_PER_REQUEST) * PACE / 60000)} minutes`);
console.log(`requests made by this pass: ${requests}`);

const verdict = ladderPerDay < EARLY_STOP_PER_DAY ? "STOP" : "CONTINUE";
console.log(`\nearly stop (ladders under ${EARLY_STOP_PER_DAY} contracts a day): ${verdict}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "size-pass.json"), JSON.stringify({ since: day(SINCE), until: day(UNTIL - 1), markets }, null, 0));
console.log(`markets written to ${join(OUT, "size-pass.json")} (gitignored; not to be committed)`);
