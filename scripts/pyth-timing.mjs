// When does a Pyth-settled 15-minute market take its settlement price?
// lib/pythTiming.js explains the question and the method: CME's move over
// the window, shifted by each offset, against Pyth's own move (settlement
// minus strike, m15_settlements); the best-fitting offset is when Pyth's
// prints were taken. If it is +60s, the outcome is decided a minute after
// trading stops and nothing seen before the close can know it.
//
// Reads the CME path from <dir>/ticks/<root>.bbo-1s.csv
// (scripts/databento-ticks.py) and m15_settlements with the service-role
// key. Buys nothing and reads no archive.
//
//   node scripts/pyth-timing.mjs --series=KXGOLD15M [--dir=databento]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { DATABENTO_ROOTS, INVERTED } from "../lib/databento.js";
import { parseTicks } from "../lib/cmeLag.js";
import { scoreOffset } from "../lib/pythTiming.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — m15_settlements is private (migration 0032)"); process.exit(2); }
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const SERIES = String(opt("series", "KXGOLD15M")).toUpperCase();
const ROOT = DATABENTO_ROOTS[SERIES];
if (!ROOT) { console.error(`::error::--series=${SERIES}: not one of ${Object.keys(DATABENTO_ROOTS).join(" ")}`); process.exit(2); }
const DIR = opt("dir", "databento");
const tickPath = join(DIR, "ticks", `${ROOT}.bbo-1s.csv`);
if (!existsSync(tickPath)) { console.error(`::error::${tickPath} is missing — run scripts/databento-ticks.py --markets=${ROOT} first`); process.exit(2); }
const T = parseTicks(readFileSync(tickPath, "utf8"), { invert: INVERTED.has(ROOT) });
if (!T.t.length) { console.error(`::error::${tickPath} holds no rows`); process.exit(1); }

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const from = new Date(T.t[0] + 900000).toISOString(), to = new Date(T.t[T.t.length - 1] - 120000).toISOString();
const W = (await pageAll(rest, "m15_settlements", "ticker,close_time,strike,value,result",
  `series=eq.${SERIES}&close_time=gte.${from}&close_time=lte.${to}`, { key: "close_time", dedupeOn: "ticker" }))
  .filter(r => (r.result === "yes" || r.result === "no") && Number.isFinite(r.value) && Number.isFinite(r.strike))
  .map(r => ({ close: Date.parse(r.close_time), strike: r.strike, value: r.value, result: r.result }));

console.log(`PYTH SETTLEMENT TIMING — ${SERIES} (Pyth) against ${ROOT}${INVERTED.has(ROOT) ? " (inverted)" : ""} front month, Databento bbo-1s mid`);
console.log(`  ${from.slice(0, 16)} -> ${to.slice(0, 16)} UTC; ${W.length} settled windows`);
console.log("  CME's move over the window, shifted by each offset from Kalshi's close_time, against Pyth's own move");
console.log("  (settlement - strike). The offset with the highest corr and lowest rmse is when Pyth's prices were taken.\n");
console.log("  offset     n    corr     rmse    side    near");
const OFFSETS = [];
for (let s = -120; s <= 150; s += s >= -30 && s < 90 ? 5 : 15) OFFSETS.push(s * 1000);
const rows = OFFSETS.map(o => scoreOffset(T, W, o));
const best = rows.filter(r => r.corr != null).reduce((a, b) => (b.corr > a.corr ? b : a), { corr: -Infinity });
const pct = v => (v == null ? "—" : `${(100 * v).toFixed(1)}%`);
for (const r of rows) {
  console.log(`  ${(r.offsetMs >= 0 ? "+" : "") + r.offsetMs / 1000 + "s"}`.padEnd(10)
    + `${String(r.n).padStart(6)}  ${r.corr == null ? "     —" : r.corr.toFixed(4)}  ${r.rmse == null ? "      —" : r.rmse.toPrecision(4).padStart(7)}  ${pct(r.side).padStart(6)}  ${pct(r.near).padStart(6)}${r === best ? "   <- best" : ""}`);
}
if (best.n) console.log(`\n  Best fit at ${best.offsetMs >= 0 ? "+" : ""}${best.offsetMs / 1000}s from close_time (corr ${best.corr.toFixed(4)}, side ${pct(best.side)}, near-strike ${pct(best.near)}).`);
console.log(`
READING THIS
- +0s means Pyth's settlement print is taken as trading stops; +60s means a minute after, when no trade can
  react to it. A broad peak means the data cannot tell offsets that close apart.
- "near" is CME's side agreement on the fifth of windows Pyth moved least: where the exact instant matters.
- CME is a proxy (futures, not Pyth's own spot aggregate), so the peak says WHEN, not how well Pyth could be
  predicted from CME.`);
