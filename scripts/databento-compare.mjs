// How far CME futures (bought from Databento by scripts/databento-fetch.py)
// sit from the Pyth prices Kalshi's commodity and FX 15-minute markets
// settle on, scored exactly as scripts/dukascopy-fetch.mjs scores
// Dukascopy (lib/dukascopy.js compareSeries), so the two read side by side.
//
//   level  how far the futures price sits from Pyth's at the close, in bp.
//          Futures carry a basis to spot (carry, roll), so a steady bias
//          here is expected and printed separately.
//   side   how often the futures' OWN move over the window points the way
//          Kalshi settled. The basis cancels in a move, so this is the
//          question a 15-minute up/down market asks.
//   near   the same on the fifth of windows that settled closest to the
//          strike: the windows a bot would actually be deciding.
//
// Kalshi's side comes from m15_settlements (migration 0032), read with the
// service-role key: the table is private like every recorded one.
//
//   node scripts/databento-compare.mjs --dir=databento
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { pageAll } from "../lib/restPage.js";
import { compareSeries } from "../lib/dukascopy.js";
import { DATABENTO_ROOTS, INVERTED, chunkSpan, parseChunk, boundaryReader, unitFactor } from "../lib/databento.js";

const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const DIR = opt("dir", "databento");
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — m15_settlements is private (migration 0032)"); process.exit(2); }
if (!existsSync(join(DIR, "run.json"))) { console.error(`::error::${DIR}/run.json is missing — the fetch step did not run`); process.exit(2); }
const run = JSON.parse(readFileSync(join(DIR, "run.json"), "utf8"));
if (run.dry) { console.log("dry run: nothing was bought, nothing to compare"); process.exit(0); }

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 70)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const pct = (a, n) => n ? `${(100 * a / n).toFixed(1)}%` : "—";
const iso = ms => new Date(ms).toISOString().slice(0, 16);
console.log(`CME FUTURES (Databento ${run.schema}, volume-front contract) AGAINST PYTH (Kalshi's settlement price at each close)`);
console.log(`  ${iso(run.from)} -> ${iso(run.to)} UTC; price = ${run.schema === "bbo-1s"
  ? "mid of the best bid and offer standing at each boundary (looked back up to 15 minutes)"
  : "last trade in the 60s before each boundary (the same trade for 1s and 1m bars)"}\n`);

const files = readdirSync(DIR);
const summary = {};
let failed = 0;
for (const [series, root] of Object.entries(DATABENTO_ROOTS)) {
  const chunks = [];
  for (const f of files) {
    const span = chunkSpan(f, root, run.schema);
    if (span) chunks.push({ span, rows: parseChunk(readFileSync(join(DIR, f), "utf8")) });
  }
  let W;
  try {
    const rows = await pageAll(rest, "m15_settlements", "ticker,close_time,strike,value,result",
      `series=eq.${series}&close_time=gte.${new Date(run.from).toISOString()}&close_time=lt.${new Date(run.to).toISOString()}`,
      { key: "close_time", dedupeOn: "ticker" });
    W = rows.filter(r => (r.result === "yes" || r.result === "no") && Number.isFinite(r.value))
      .map(r => ({ close: Date.parse(r.close_time), value: r.value, strike: r.strike, result: r.result }))
      .sort((a, b) => a.close - b.close);
  } catch (e) { console.log(`  ${series.padEnd(15)} ::warning::${e.message}`); failed++; continue; }

  const invert = INVERTED.has(root);
  const raw = boundaryReader(chunks, { invert });
  const pairs = W.map(w => [raw.mid(w.close).mid, w.value]).filter(([p]) => p != null);
  const { factor, medErr } = unitFactor(pairs);
  const R = compareSeries(W, boundaryReader(chunks, { invert, factor }));
  summary[series] = { root, windows: W.length, factor, invert, ...R };
  const tag = `${root}${invert ? " 1/x" : ""}${factor !== 1 ? ` x${+factor.toPrecision(6)}` : ""}`;
  if (!W.length) { console.log(`  ${series.padEnd(15)} ${tag}: no settled windows in m15_settlements for this span`); continue; }
  if (!R.n) { console.log(`  ${series.padEnd(15)} ${tag}: ${W.length} settled windows, none comparable (not bought ${R.why.missing}, no price at the boundary ${R.why.stale})`); continue; }
  console.log(`  ${series.padEnd(15)} ${tag.padEnd(10)} ${String(R.n).padStart(5)} of ${String(W.length).padStart(5)} windows  `
    + `level median ${R.level.medianBp.toFixed(1)}bp p90 ${R.level.p90Bp.toFixed(1)}bp futures-Pyth ${R.level.biasMedian.toPrecision(3)}  `
    + `side ${pct(R.side.agree, R.side.n)}  near ${pct(R.close.agree, R.close.n)} of ${R.close.n}  `
    + `(flat ${R.side.flat}, no price ${R.why.stale}, price ${R.ageP50s.toFixed(1)}s old)`);
  if (medErr != null && medErr > 0.05) console.log(`  ${"".padEnd(15)} ::warning::units: no known factor brings ${root} within 5% of Pyth (median ${(100 * medErr).toFixed(0)}%) — read the level column as unit mismatch, side and near still hold`);
}
writeFileSync(join(DIR, "summary.json"), JSON.stringify({ at: new Date().toISOString(), run, summary }, null, 1));
console.log(`\nA proxy is worth what "near" says. Coin-flip is 50%; a bot needs it close to 100% on the windows it trades.`);
process.exit(failed ? 1 : 0);
