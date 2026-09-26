// Can the Actions weather recorder be turned off?
//
// The weather recorder runs in two places for a couple of days: the box
// and the GitHub Actions job it replaces. Both append to wx_quotes,
// which is safe — write-on-change and append-only, so an overlap costs
// duplicate rows and never a gap — but it leaves the decision
// unanswerable from the table alone.
//
// UNION COVERAGE IS NOT THE ANSWER, and it is the number that will be
// reached for. If the two together cover every hour, that reads
// identically whether the box covered all of them or half. Neither half
// of this dataset is backfillable — a settled Kalshi market reports one
// last price, and NWS serves the CURRENT forecast, never the one it was
// issuing yesterday afternoon — so turning Actions off on a union
// figure risks learning the difference through a week of lost book and
// forecast.
//
// So this reports coverage PER SOURCE. The box may be made sole
// recorder when its own column stands up without help.
//
// WHY HOURS AND NOT WINDOWS. m15-coverage has a natural denominator:
// fifteen-minute markets that closed, listed in m15_markets. A daily
// temperature market is open for a day, so "markets that existed" is
// not a unit of recording — the thing being covered is TIME. A running
// recorder polls every 10 minutes and its write-on-change heartbeat is
// 15, so an hour with no row from a source is an hour that source was
// not recording.
//
// That makes the denominator wall-clock hours, which CAN be short for a
// reason that is not a recorder fault: an hour in which Kalshi listed
// no open daily temperature markets at all. It would hit both sources
// equally, so the per-source comparison still holds — but if the UNION
// row is short, check that before treating it as an outage.
//
// Reads only, anon key. Writes nothing.

import { pageAll as page } from "../lib/restPage.js";
import { authHeaders } from "../lib/supabaseHeaders.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const HOURS = Number(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || 48);

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { ...authHeaders(KEY) } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// DOES THE COLUMN EXIST? Asked first, because every reading below
// depends on it and "no rows from the box" has three causes that look
// identical from the table: the migration was never run, the recorders
// are running code from before the stamp, or the box is not writing at
// all. A verdict listing three possibilities is not a verdict.
//
// PostgREST answers directly: selecting a column that does not exist is
// a 400 naming it, not an empty result.
let haveColumn = true;
try {
  await rest("wx_quotes?select=source&limit=1");
} catch (e) {
  if (/source/.test(String(e.message))) haveColumn = false;
  else throw e;
}

// COMPLETE HOURS ONLY. The hour in progress is being recorded right
// now and has not had its chance to be missed; counting it would
// penalise whichever source happens not to have written in the last
// four minutes. Same reason m15-coverage counts only closed windows.
const HOUR = 3600 * 1000;
const endMs = Math.floor(Date.now() / HOUR) * HOUR;
const startMs = endMs - HOURS * HOUR;
const since = new Date(startMs).toISOString();
const until = new Date(endMs).toISOString();

// FILTER ON THE KEY YOU PAGE ON, or Postgres sorts the whole window.
// The m15 version of this read filtered observed_at and paged on id, so
// every page found rows by time and then ORDERED them by id — a sort
// over the entire window rather than an index walk. It returned
// `57014 canceling statement due to statement timeout` at exactly the
// 24h window worth asking about.
//
// wx_quotes is append-only with a bigserial key, so id is monotonic in
// time: two cheap lookups turn the time boundaries into id boundaries,
// and the scan between them is a pure keyset walk on the primary key
// with no sort and no time predicate at all.
//
// id is monotonic in INSERT order, not perfectly in observed_at — two
// recorders write concurrently and observed_at is stamped client-side
// at the start of a tick. The slack is one tick at each edge, which is
// noise against a 48-hour window and is why the boundaries do not need
// to be exact.
const firstRow = await rest(`wx_quotes?select=id&observed_at=gte.${since}&order=observed_at.asc&limit=1`);
const lastRow  = await rest(`wx_quotes?select=id&observed_at=lt.${until}&order=observed_at.desc&limit=1`);
const sinceId = firstRow[0]?.id ?? null;
const untilId = lastRow[0]?.id ?? null;

// No rows at all in the window is a real answer, not an error — it is
// what a stopped recorder looks like, and the verdict below says so.
const quotes = (sinceId == null || untilId == null) ? [] : await page(rest,
  "wx_quotes", haveColumn ? "id,observed_at,source" : "id,observed_at",
  `id=gte.${sinceId}&id=lte.${untilId}`,
);

const hourOf = iso => Math.floor(Date.parse(iso) / HOUR);
const firstHour = Math.floor(startMs / HOUR);
const totalHours = HOURS;

const seen = new Map();          // source -> Set(hour index)
const stamps = new Map();        // source -> sorted ms, for the gap figure
let outside = 0;
for (const q of quotes) {
  const t = Date.parse(q.observed_at);
  if (!(t >= startMs && t < endMs)) { outside++; continue; }
  const s = q.source || "(before attribution)";
  if (!seen.has(s)) { seen.set(s, new Set()); stamps.set(s, []); }
  seen.get(s).add(hourOf(q.observed_at) - firstHour);
  stamps.get(s).push(t);
}

// THE LONGEST GAP, because an hourly figure hides a 55-minute hole. A
// source can score 100% of hours while never once recording two
// consecutive polls, and on a dataset that cannot be backfilled the
// shape of the coverage matters as much as its total.
//
// The window edges count: a source that wrote nothing for the first six
// hours has a six-hour gap, not a clean run starting late.
function longestGapMin(list) {
  if (!list.length) return null;
  const xs = [...list].sort((a, b) => a - b);
  let gap = Math.max(xs[0] - startMs, endMs - xs[xs.length - 1]);
  for (let i = 1; i < xs.length; i++) gap = Math.max(gap, xs[i] - xs[i - 1]);
  return Math.round(gap / 60000);
}

const pct = n => `${(100 * n / totalHours).toFixed(1)}%`;

console.log(`WEATHER COVERAGE  last ${HOURS}h  —  ${totalHours} complete hours`);
console.log(`source column: ${haveColumn ? "present" : "ABSENT (migration 0026 not applied)"}`);
if (outside) console.log(`(${outside} rows outside the window, excluded — id boundaries are approximate by one tick)`);
console.log("");
console.log("source                     hours seen   coverage   longest gap");
console.log("=".repeat(63));
const rows = [...seen.entries()].sort((a, b) => b[1].size - a[1].size);
for (const [src, set] of rows) {
  const g = longestGapMin(stamps.get(src));
  console.log(`${src.padEnd(24)} ${String(set.size).padStart(11)}   ${pct(set.size).padStart(8)}   ${(g == null ? "n/a" : `${g}m`).padStart(11)}`);
}

const union = new Set();
for (const [, set] of seen) for (const h of set) union.add(h);
const allStamps = [...stamps.values()].flat();
console.log("=".repeat(63));
console.log(`${"union (all sources)".padEnd(24)} ${String(union.size).padStart(11)}   ${pct(union.size).padStart(8)}   ${(allStamps.length ? `${longestGapMin(allStamps)}m` : "n/a").padStart(11)}`);

// The verdict, stated rather than left to be inferred. Each branch
// names ONE cause and what to do about it.
const box = seen.get("box")?.size ?? 0;
const unattributed = seen.get("(before attribution)")?.size ?? 0;
console.log("");

if (!haveColumn) {
  console.log("VERDICT: cannot tell. wx_quotes has no `source` column, so every row");
  console.log("reads the same. Run supabase/migrations/0026_wx_quotes_source.sql, then");
  console.log("re-run this. The recorders are unaffected — they drop the column and");
  console.log("keep recording, which is why nothing is failing.");
} else if (!seen.size) {
  console.log("VERDICT: NOTHING IS RECORDING. No quotes at all in the window, on any");
  console.log("source. Neither the book nor the forecast can be backfilled, so treat");
  console.log("this as urgent.");
} else if (!seen.has("box") && !seen.has("actions") && unattributed) {
  // This branch must not guess. The m15 version of it once asserted
  // "both recorders are still running pre-stamp code" and finished
  // "recording is healthy" — a claim about TWO writers from evidence
  // supporting only "at least one writer is on old code", and a claim
  // about the TABLE relayed as a claim about the BOX. The box was in
  // fact writing nothing, rejected on every call with 401 Invalid API
  // key, for fourteen hours.
  console.log("VERDICT: CANNOT TELL, and this is not the same as healthy.");
  console.log(`The column exists but all ${unattributed} hours are unattributed, which is`);
  console.log("equally consistent with both recorders running pre-stamp code AND with");
  console.log("the box writing nothing while Actions covers for it. The table being");
  console.log("fresh says nothing about the box.");
  console.log("");
  console.log("Settle it on the box, where the answer is unambiguous:");
  console.log("  sudo journalctl -u marketslap-weather -n 30 --no-pager");
  console.log("Then re-run this once the box has cycled (hourly) onto stamped code.");
} else if (!seen.has("box")) {
  console.log("VERDICT: THE BOX IS NOT WRITING. Other sources are landing rows, so this");
  console.log("is not the column and not the migration. Check the service:");
  console.log("  systemctl status marketslap-weather");
  console.log("Every hour lost here is lost for good.");
} else if (box >= union.size) {
  console.log(`VERDICT: the box alone covers ${pct(box)}, matching the union.`);
  console.log("Actions is adding nothing and record-weather.yml can be turned off.");
} else {
  const miss = union.size - box;
  console.log(`VERDICT: not yet. The box alone covers ${pct(box)}; the union covers ${pct(union.size)}.`);
  console.log(`${miss} hour${miss === 1 ? "" : "s"} would be LOST by turning Actions off today.`);
  console.log("Leave both running and re-check — an hour missed is not recoverable.");
}
