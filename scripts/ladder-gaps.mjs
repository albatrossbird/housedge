// Ladder step 2, the analysis (docs/research/ladder-step2-plan.md): gap
// lifetimes and the fill replay over the ladder recorder's archive.
//
//   node --max-old-space-size=6000 scripts/ladder-gaps.mjs --since=2026-11-15 --until=2026-11-18
//
// Reads ladder/ from the PRIVATE stream-archive bucket (service-role key),
// one hourly file at a time, and Kalshi's public /markets for each
// market's settlement (the held-to-settlement price of a one-legged
// fill). Prints, per UTC day and in total:
//   - qualifying gaps (1c+ a contract after fees, 10+ at both touches),
//     how long they lasted and what closed them;
//   - the fill replay at +0/+25/+50/+100/+250ms, 40 and 10 contracts:
//     both legs, one leg (unwound at the bid, and held to settlement);
//   - the plan's two verdicts: the early stop (median lifetime under
//     50ms, from 3 recorded days) and the build bar ($10 a day unwound at
//     +100ms, both weeks positive, from 14 days).
//
// It says what it will read before reading: file count and megabytes.

import { archiveReader } from "../lib/archiveRead.js";
import { analyzeClose, summarize } from "../lib/ladderBook.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { seriesOfTicker } from "../lib/ladder.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the archive bucket is private"); process.exit(2); }
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SINCE = Date.parse(`${opt("since")}T00:00:00Z`), UNTIL = Date.parse(`${opt("until")}T00:00:00Z`);
if (!(SINCE < UNTIL)) { console.error("::error::--since=YYYY-MM-DD and --until=YYYY-MM-DD (end exclusive) are required"); process.exit(2); }
const SIZES = [40, 10], DELAYS = [0, 25, 50, 100, 250];
const EARLY_MS = 50, EARLY_DAYS = 3, BUILD_DAYS = 14, BUILD_PER_DAY = 10, BUILD_KEY = "100/40";
const fee = (p, n) => kalshiTakerFee(p, n, 1, 0.0001);   // every series here is quadratic x1 (ladder-plan.md, size pass)
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const reader = archiveReader({ url: URL, key: KEY });
const files = (await reader.listRange("ladder", SINCE, UNTIL - 1)).filter(f => !/_probe/.test(f.path));
const bytes = files.reduce((s, f) => s + (f.size || 0), 0);
console.log(`LADDER GAPS ${opt("since")} .. ${opt("until")} (end exclusive): reading ${files.length} files, ${(bytes / 1e6).toFixed(0)} MB from Storage`);
const byHour = new Map();
for (const f of files) { const h = f.path.split("/").slice(1, 3).join("T"); if (!byHour.has(h)) byHour.set(h, []); byHour.get(h).push(f); }

// Settlements, public: /markets?tickers= takes a comma list.
const results = new Map();
async function loadResults(tickers) {
  const need = tickers.filter(t => !results.has(t));
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    for (let k = 0; k < 5; k++) {
      const r = await fetch(`${KALSHI}/markets?tickers=${chunk.join(",")}&limit=100`);
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * 2 ** k); continue; }
      if (r.ok) for (const m of (await r.json()).markets || []) if (m.result === "yes" || m.result === "no") results.set(m.ticker, m.result);
      break;
    }
    await sleep(220);
  }
}

const KEEP = /"k":"(mkt|full|d|tr|gap|sel)"/;
const days = new Map();   // day -> { closes, late, episodes: [], counts }
const all = [];
let hoursDone = 0;
for (const [h, fs] of [...byHour].sort()) {
  const lines = [];
  for (const f of fs) await reader.eachLine(f.path, o => lines.push(o), l => KEEP.test(l));
  const tickers = [...new Set(lines.filter(l => l.k === "mkt").map(l => l.m))];
  if (!tickers.length) continue;
  await loadResults(tickers);
  const r = analyzeClose(lines, { fee, results, sizes: SIZES, delays: DELAYS });
  const day = h.slice(0, 10), d = days.get(day) || { closes: 0, late: 0, episodes: [], skippedBusy: 0, untrusted: 0 };
  d.closes++; if (lines.some(l => l.k === "sel" && l.late)) d.late++;
  d.skippedBusy += r.counts.skippedBusy; d.untrusted += r.counts.untrusted;
  for (const e of r.episodes) { e.day = day; d.episodes.push(e); all.push(e); }
  days.set(day, d);
  if (++hoursDone % 12 === 0) console.error(`  ${hoursDone}/${byHour.size} closes read`);
}

const $ = v => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);
const nDays = days.size;
console.log(`\n${nDays} recorded days, ${[...days.values()].reduce((s, d) => s + d.closes, 0)} closes, ${all.length} qualifying gaps (1c+ after fees, 10+ contracts at both touches)`);
console.log("\nday         closes  gaps   median ms  p10   p90   under 50ms   closed by: trade / quote / close / unknown");
for (const [day, d] of [...days].sort()) {
  const s = summarize(d.episodes, { sizes: SIZES, delays: DELAYS });
  console.log(`${day}  ${String(d.closes).padStart(6)} ${String(s.n).padStart(5)}  ${String(s.p50 ?? "—").padStart(9)}  ${String(s.p10 ?? "—").padStart(4)}  ${String(s.p90 ?? "—").padStart(4)}  ${(s.n ? (100 * s.under50 / s.n).toFixed(0) + "%" : "—").padStart(10)}   ${s.cause.trade || 0} / ${s.cause.quote || 0} / ${s.cause.close || 0} / ${s.cause.unknown || 0}${d.late ? `   (${d.late} started late)` : ""}`);
}
const S = summarize(all, { sizes: SIZES, delays: DELAYS });
console.log(`all         ${"".padStart(6)} ${String(S.n).padStart(5)}  ${String(S.p50 ?? "—").padStart(9)}  ${String(S.p10 ?? "—").padStart(4)}  ${String(S.p90 ?? "—").padStart(4)}  ${(S.n ? (100 * S.under50 / S.n).toFixed(0) + "%" : "—").padStart(10)}   ${S.cause.trade || 0} / ${S.cause.quote || 0} / ${S.cause.close || 0} / ${S.cause.unknown || 0}`);

console.log("\nby pair (NO on X > YES on Y): gaps, median ms, median edge at open");
const byPair = new Map();
for (const e of all) { const k = `${seriesOfTicker(e.x)} > ${seriesOfTicker(e.y)}`; if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(e); }
const med = a => a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : null;
for (const [k, es] of [...byPair].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k.padEnd(24)} ${String(es.length).padStart(6)}  ${String(med(es.map(e => e.ms))).padStart(6)}ms  ${(100 * med(es.map(e => e.edge0))).toFixed(1)}c`);

console.log("\nby time to the close at the open: gaps, median ms");
for (const [label, lo, hi] of [["under 1m", 0, 60], ["1-5m", 60, 300], ["5-16m", 300, 1e9]]) { const es = all.filter(e => e.toClose >= lo && e.toClose < hi); console.log(`  ${label.padEnd(10)} ${String(es.length).padStart(6)}  ${String(med(es.map(e => e.ms)) ?? "—").padStart(6)}ms`); }

console.log(`\nTHE FILL REPLAY (both legs sent at the prices seen when the gap opens; filled at the delay against the recorded book)`);
console.log("delay  size  attempts  both legs  one leg  nothing   unwound total  a day    held total  a day   settlement unknown");
for (const L of DELAYS) for (const size of SIZES) {
  const c = S.capture[`${L}/${size}`];
  console.log(`${`+${L}ms`.padStart(6)} ${String(size).padStart(4)}  ${String(c.attempts).padStart(8)}  ${String(c.both).padStart(9)}  ${String(c.legged).padStart(7)}  ${String(c.nothing).padStart(7)}   ${$(c.unwound).padStart(13)}  ${$(c.unwound / nDays).padStart(7)}  ${$(c.held).padStart(11)}  ${$(c.held / nDays).padStart(7)}   ${c.unknown}`);
}
const skipped = [...days.values()].reduce((s, d) => s + d.skippedBusy, 0), untrusted = [...days.values()].reduce((s, d) => s + d.untrusted, 0);
console.log(`not attempted because a leg was already in flight: ${skipped}; books distrusted after a sequence gap: ${untrusted}`);
console.log("Upper bound: when we and the bot already there arrive together, the replay gives us the fill.");

// The plan's verdicts.
console.log("\nVERDICTS");
if (nDays < EARLY_DAYS) console.log(`  early stop: not yet (${nDays} of ${EARLY_DAYS} days)`);
else console.log(`  early stop (median qualifying gap under ${EARLY_MS}ms): ${S.p50 != null && S.p50 < EARLY_MS ? `STOP — median ${S.p50}ms` : `continue — median ${S.p50}ms`}`);
if (nDays < BUILD_DAYS) console.log(`  build bar: not yet (${nDays} of ${BUILD_DAYS} days)`);
else {
  const sorted = [...days].sort(), half = Math.floor(sorted.length / 2);
  const wk = ds => ds.reduce((s, [, d]) => s + (summarize(d.episodes, { sizes: SIZES, delays: DELAYS }).capture[BUILD_KEY].unwound), 0);
  const w1 = wk(sorted.slice(0, half)), w2 = wk(sorted.slice(half)), perDay = S.capture[BUILD_KEY].unwound / nDays;
  console.log(`  build bar ($${BUILD_PER_DAY} a day unwound at +100ms, 40 contracts, both halves positive): ${perDay >= BUILD_PER_DAY && w1 > 0 && w2 > 0 ? "PASS" : "FAIL"} — ${$(perDay)} a day; halves ${$(w1)} / ${$(w2)}`);
}
