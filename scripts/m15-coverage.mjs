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

// The denominator is WINDOWS THAT EXISTED, taken from m15_markets, not
// from the quotes themselves. Deriving it from quotes would define
// coverage as the windows we covered, which is 100% by construction —
// the same shape of error as a counter that can only be non-zero.
const windows = await page(rest,
  "m15_markets", "ticker,close_time",
  `close_time=gte.${since}&close_time=lte.${new Date().toISOString()}`,
  { key: "ticker" },
);

const quotes = await page(rest,
  "m15_quotes", "id,ticker,source",
  `observed_at=gte.${since}`,
);

const seen = new Map();          // source -> Set(ticker)
for (const q of quotes) {
  const s = q.source || "(before attribution)";
  if (!seen.has(s)) seen.set(s, new Set());
  seen.get(s).add(q.ticker);
}

const total = new Set(windows.map(w => w.ticker));
const pct = n => total.size ? `${(100 * n / total.size).toFixed(1)}%` : "n/a";

console.log(`M15 COVERAGE  last ${HOURS}h  —  ${total.size} windows closed\n`);
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
const box = seen.get("box")?.size ?? 0;
console.log("");
if (!seen.has("box")) {
  console.log("No rows from the box yet. Either it is not recording, or");
  console.log("migration 0023_m15_quotes_source.sql has not been run —");
  console.log("check for '(before attribution)' rows newer than the box start.");
} else if (box >= union.size) {
  console.log(`The box alone covers ${pct(box)}, matching the union.`);
  console.log("Actions is adding nothing and can be turned off.");
} else {
  const miss = union.size - box;
  console.log(`The box alone covers ${pct(box)}; the union covers ${pct(union.size)}.`);
  console.log(`${miss} window${miss === 1 ? "" : "s"} would be LOST by turning Actions off today.`);
  console.log("Leave both running and re-check — a window missed is not recoverable.");
}
