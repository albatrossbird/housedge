// Can the Actions recorder be turned off?
//
// The 15-minute recorder runs in two places for a couple of days: the
// VPS and the GitHub Actions job it is replacing. Both append to
// m15_quotes, which is safe — write-on-change and append-only, so an
// overlap costs duplicate rows and never a gap — but it leaves the
// decision unanswerable from the table alone.
//
// UNION COVERAGE IS NOT THE ANSWER, and it is the number that will be
// reached for. If the two together cover every window, that reads
// identically whether the box covers all of them or half. Turning
// Actions off on that basis risks finding out through a week of missing
// price path, and the price path cannot be backfilled — two independent
// attempts confirmed it, most recently Kairos 1-minute candles landing
// inside our recorded book only 11.4% of the time.
//
// So this reports coverage PER SOURCE: of the windows that existed,
// what fraction did each recorder see on its own. The box may be turned
// to sole recorder when its own column stands up without help.
//
// Reads only, anon key. Writes nothing.

import { pageAll as page } from "../lib/restPage.js";

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

const HOURS = Number(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || 48);
const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// DOES THE COLUMN EXIST? Asked first, because every other reading below
// depends on the answer and "no rows from the box" has three causes
// that look identical from the table: the migration was never run, the
// recorders are running code from before the stamp, or the box is not
// writing at all. A verdict that lists three possibilities is not a
// verdict — it is the reader's problem again.
//
// PostgREST answers this directly: selecting a column that does not
// exist is a 400 naming it, not an empty result.
let haveColumn = true;
try {
  await rest("m15_quotes?select=source&limit=1");
} catch (e) {
  if (/source/.test(String(e.message))) haveColumn = false;
  else throw e;
}

// The denominator is WINDOWS THAT EXISTED, taken from m15_markets, not
// from the quotes themselves. Deriving it from quotes would define
// coverage as the windows we covered, which is 100% by construction —
// the same shape of error as a counter that can only be non-zero.
//
// CLOSED windows only, and the numerator is INTERSECTED with them. A
// window still open is being recorded right now and has not had its
// chance to be missed, so counting its quotes against a denominator it
// is not in produced 273 of 252 — a coverage figure of 108.3%, which
// is not a stricter measure but a meaningless one.
const nowIso = new Date().toISOString();
const windows = await page(rest,
  "m15_markets", "ticker,close_time",
  `close_time=gte.${since}&close_time=lte.${nowIso}`,
  { key: "ticker" },
);

const quotes = await page(rest,
  "m15_quotes", haveColumn ? "id,ticker,source" : "id,ticker",
  `observed_at=gte.${since}`,
);

const total = new Set(windows.map(w => w.ticker));

const seen = new Map();          // source -> Set(ticker), closed windows only
let liveSkipped = 0;
for (const q of quotes) {
  if (!total.has(q.ticker)) { liveSkipped++; continue; }
  const s = q.source || "(before attribution)";
  if (!seen.has(s)) seen.set(s, new Set());
  seen.get(s).add(q.ticker);
}

const pct = n => total.size ? `${(100 * n / total.size).toFixed(1)}%` : "n/a";

console.log(`M15 COVERAGE  last ${HOURS}h  —  ${total.size} windows closed`);
console.log(`source column: ${haveColumn ? "present" : "ABSENT (migration 0023 not applied)"}`);
if (liveSkipped) {
  console.log(`(${liveSkipped} quotes on windows not yet closed, excluded from both sides)`);
}
console.log("");
console.log("source                    windows seen   coverage");
console.log("=".repeat(52));
const rows = [...seen.entries()].sort((a, b) => b[1].size - a[1].size);
for (const [src, set] of rows) {
  console.log(`${src.padEnd(24)} ${String(set.size).padStart(12)}   ${pct(set.size).padStart(8)}`);
}

const union = new Set();
for (const [, set] of seen) for (const t of set) union.add(t);
console.log("=".repeat(52));
console.log(`${"union (all sources)".padEnd(24)} ${String(union.size).padStart(12)}   ${pct(union.size).padStart(8)}`);

// The verdict, stated rather than left to be inferred from the table.
// Each branch names ONE cause and what to do about it.
const box = seen.get("box")?.size ?? 0;
const unattributed = seen.get("(before attribution)")?.size ?? 0;
console.log("");

if (!haveColumn) {
  console.log("VERDICT: cannot tell. m15_quotes has no `source` column, so every");
  console.log("row reads the same. Run supabase/migrations/0023_m15_quotes_source.sql,");
  console.log("then re-run this. The recorders are unaffected — they drop the column");
  console.log("and keep recording, which is why nothing is failing.");
} else if (!seen.size) {
  console.log("VERDICT: NOTHING IS RECORDING. No quotes at all in the window, on any");
  console.log("source. The price path cannot be backfilled, so treat this as urgent.");
} else if (!seen.has("box") && !seen.has("actions") && unattributed) {
  console.log(`VERDICT: not yet. The column exists but all ${unattributed} windows are`);
  console.log("unattributed, so both recorders are still running code from before the");
  console.log("stamp landed. The box cycles hourly and an Actions run lasts 330");
  console.log("minutes, so give it until the current run ends and re-check. Recording");
  console.log("is healthy meanwhile — this is an attribution gap, not a data gap.");
} else if (!seen.has("box")) {
  console.log("VERDICT: THE BOX IS NOT WRITING. Other sources are landing rows, so");
  console.log("this is not the column and not the migration. Check the service on the");
  console.log("box: systemctl status marketslap-m15. The price path cannot be");
  console.log("backfilled, so every window lost here is lost for good.");
} else if (box >= union.size) {
  console.log(`VERDICT: the box alone covers ${pct(box)}, matching the union.`);
  console.log("Actions is adding nothing and can be turned off.");
} else {
  const miss = union.size - box;
  console.log(`VERDICT: not yet. The box alone covers ${pct(box)}; the union covers ${pct(union.size)}.`);
  console.log(`${miss} window${miss === 1 ? "" : "s"} would be LOST by turning Actions off today.`);
  console.log("Leave both running and re-check — a window missed is not recoverable.");
}
