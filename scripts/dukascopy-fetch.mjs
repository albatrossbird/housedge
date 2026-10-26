// Dukascopy's free tick history for the commodity and FX 15-minute
// markets, kept on the box, and how far it sits from the Pyth prices
// those markets settle on. lib/dukascopy.js has the why and the format.
//
// Runs on the box from marketslap-dukascopy.timer, daily. The first run
// fills from DUKA_FROM — 2026-08-18, because Kalshi lists settled markets
// only back to 2026-08-19 (measured 2026-10-26) and earlier hours would
// have nothing to compare with — and takes hours at one paced request; every later run
// fetches only the hours since, then reprints the comparison. Files stay
// in the unit's StateDirectory, ~1GB in all. Nothing is uploaded.
//
// HOLDS NO KEY. Dukascopy's files and Kalshi's settled markets are both
// public, so the unit loads no EnvironmentFile.
//
//   node scripts/dukascopy-fetch.mjs [--compare-only] [--from=2026-08-18]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DUKA_SYMBOLS, fetchHistory, tickReader, compareSeries } from "../lib/dukascopy.js";
import { kalshiGet } from "../lib/m15.js";

const env = process.env;
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DIR = env.DUKA_DIR || env.STATE_DIRECTORY || "/var/lib/marketslap-dukascopy";
const FROM_MS = Date.parse(`${opt("from", env.DUKA_FROM || "2026-08-18")}T00:00:00Z`);
const PACE_MS = Number(env.DUKA_PACE_MS || 1500);
// Dukascopy publishes an hour's file after it ends; three hours' margin.
const TO_MS = Math.floor(Date.now() / 3600000) * 3600000 - Number(env.DUKA_LAG_HOURS ?? 3) * 3600000;
// Stop fetching in time to compare before systemd's RuntimeMaxSec.
const DEADLINE = Date.now() + Number(env.DUKA_FETCH_HOURS || 18) * 3600000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!Number.isFinite(FROM_MS)) { console.error("::error::--from must be YYYY-MM-DD"); process.exit(2); }
if (spawnSync("xz", ["--version"]).status !== 0) { console.error("::error::xz is not installed — sudo apt install xz-utils"); process.exit(2); }

const series = Object.keys(DUKA_SYMBOLS);
log(`Dukascopy history in ${DIR}, ${new Date(FROM_MS).toISOString().slice(0, 10)} -> ${new Date(TO_MS).toISOString().slice(0, 13)}h, ${series.length} instruments`);

let unavailable = [];
if (!process.argv.includes("--compare-only")) {
  const t0 = Date.now();
  const S = await fetchHistory({ dir: DIR, symbols: series.map(s => DUKA_SYMBOLS[s]), fromMs: FROM_MS, toMs: TO_MS, paceMs: PACE_MS, deadlineMs: DEADLINE, log });
  unavailable = S.unavailable;
  log(`fetched ${S.fetched} hours (${(S.bytes / 1e6).toFixed(1)} MB, ${S.empty} with no quotes), ${S.skipped} already here, throttled ${S.throttled} times, ${S.failed} failed, in ${((Date.now() - t0) / 60000).toFixed(0)} min${S.unavailable.length ? `; not on Dukascopy: ${S.unavailable.join(" ")}` : ""}`);
}

// Kalshi's settled windows: Pyth's price at every close, and the strike.
async function settled(ticker) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 30; page++) {
    const r = await kalshiGet(`/markets?series_ticker=${ticker}&status=settled&min_close_ts=${Math.floor(FROM_MS / 1000)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!r.ok) throw new Error(`${ticker}: Kalshi ${r.status || r.error}`);
    for (const m of r.body.markets || []) {
      const value = Number(m.expiration_value), close = Date.parse(m.close_time);
      if ((m.result === "yes" || m.result === "no") && m.expiration_value != null && m.expiration_value !== "" && Number.isFinite(value) && close < TO_MS)
        out.push({ close, value, strike: m.floor_strike ?? null, result: m.result });
    }
    cursor = r.body.cursor || "";
    if (!cursor) break;
  }
  return out.sort((a, b) => a.close - b.close);
}

const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
console.log(`\nDUKASCOPY AGAINST PYTH (Kalshi's settlement price at each window close)`);
console.log(`  level: how far Dukascopy's mid sits from Pyth's price at the close, in basis points (1bp = 0.01%)`);
console.log(`  side:  how often Dukascopy's own move over the window points the way Kalshi settled`);
console.log(`  near:  the same, on the fifth of windows that settled closest to the strike\n`);
const summary = {};
for (const s of series) {
  const sym = DUKA_SYMBOLS[s];
  if (unavailable.includes(sym)) { console.log(`  ${s.padEnd(15)} ${sym}: not on Dukascopy under this name`); continue; }
  let W;
  try { W = await settled(s); } catch (e) { console.log(`  ${s.padEnd(15)} ::warning::${e.message}`); continue; }
  const R = compareSeries(W, tickReader(DIR, sym));
  summary[s] = { sym, windows: W.length, ...R };
  if (!R.n) { console.log(`  ${s.padEnd(15)} ${sym}: ${W.length} settled windows, none comparable (no copy ${R.why.missing}, no quote within 60s ${R.why.stale})`); continue; }
  console.log(`  ${s.padEnd(15)} ${sym.padEnd(13)} ${String(R.n).padStart(5)} of ${String(W.length).padStart(5)} windows  `
    + `level median ${R.level.medianBp.toFixed(1)}bp p90 ${R.level.p90Bp.toFixed(1)}bp  `
    + `side ${pct(R.side.agree, R.side.n)}  near ${pct(R.close.agree, R.close.n)}  (flat ${R.side.flat}, last quote ${R.ageP50s.toFixed(1)}s old)`);
}
writeFileSync(join(DIR, "summary.json"), JSON.stringify({ at: new Date().toISOString(), from: FROM_MS, to: TO_MS, summary }, null, 1));
console.log(`\nA proxy is worth what "near" says: those are the windows a bot would actually be deciding.`);
