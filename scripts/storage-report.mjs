import { authHeaders } from "../lib/supabaseHeaders.js";
// How fast is this database actually growing, and when does it matter?
//
// m15_quotes and wx_quotes are APPEND-ONLY and nothing deletes from
// them. The retention decision has been open for days on the strength
// of an estimate in CLAUDE.md, and this project has a long record of
// estimates being wrong in exactly this way — "~11,300 embedded rows"
// turned out to be 37,518, a 3.3x miss that changed the conclusion.
//
// So: measure.
//
// WHAT THIS CAN AND CANNOT SEE. PostgREST serves row COUNTS, not table
// BYTES — pg_total_relation_size needs SQL. So counts and growth are
// measured here and clearly separated from the byte figure, which is a
// per-row ESTIMATE and labelled as one. supabase/queries/storage.sql
// holds the exact query to run in the dashboard.
//
// COUNTS ARE PLANNER ESTIMATES ON PURPOSE. An exact count of a
// multi-million-row table is a full scan, and this repo has twice been
// killed by 57014 doing something like that. `count=planned` reads
// pg_class.reltuples — approximate, instant, and accurate enough for a
// capacity decision. The 24-hour windows use exact counts because they
// ride the observed_at index and are small.
//
// Reads only, anon key. Writes nothing.

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

// Supabase Pro includes 8 GB.
const CEILING_GB = Number(process.env.CEILING_GB || 8);

// Bytes per row INCLUDING index entries, estimated from column widths
// plus Postgres' 23-byte tuple header and per-index overhead. Stated
// per table rather than as one number, because a five-column quote row
// and a twenty-column market row are not the same object.
//
// THE FIRST VERSION OF THIS WAS 2.8x LOW, and it was low for one
// reason. It charged `markets` a flat 600 bytes a row. But an embedded
// market carries a vector(1024), and this project has already MEASURED
// what that costs: 147MB across 37,518 rows, 4.01KB each, because
// float arrays are high-entropy and TOAST compresses them to nothing.
// Averaging that into a per-row figure would be wrong in the other
// direction, since most rows carry no vector at all.
//
// So the wide subset is COUNTED rather than assumed — one more REST
// call asking how many rows are embedded — and charged the measured
// width. An estimate built on a measurement of the thing that
// dominates it is a different object from one built on a guess.
const BYTES = {
  m15_quotes:   210,  // id, ticker, ts, int, 5 doubles, 2 indexes
  wx_quotes:    210,
  wx_forecasts: 260,  // + short_forecast text
  m15_markets:  330,
  wx_markets:   380,
  markets:      600,  // the NARROW case; see WIDE below
  pairs:        120,
};

// Rows matching the filter cost `bytes` INSTEAD of the table's base
// figure, not on top of it.
const WIDE = {
  markets: {
    filter: "&embedding_v=not.is.null",
    bytes: 4600,            // 4.01KB measured vector + the row around it
    note: "carry a vector(1024)",
  },
};

async function count(table, filter = "", mode = "planned") {
  const r = await fetch(`${URL}/rest/v1/${table}?select=*${filter}&limit=1`, {
    headers: { ...authHeaders(KEY), Prefer: `count=${mode}` },
  });
  if (!r.ok) return { n: null, err: `${r.status} ${(await r.text()).slice(0, 90)}` };
  // Content-Range is "0-0/12345"; the total is after the slash and can
  // be "*" when the server declines to count.
  const cr = r.headers.get("content-range") || "";
  const total = cr.split("/")[1];
  return { n: total && total !== "*" ? Number(total) : null, err: null };
}

const gb = bytes => bytes / 1024 ** 3;
const fmt = n => (n == null ? "?" : n.toLocaleString("en-US"));

const TABLES = ["m15_quotes", "wx_quotes", "wx_forecasts", "m15_markets", "wx_markets", "markets", "pairs"];
// Only the append-only tables have a meaningful growth rate; the rest
// are upserted in place and churn rather than grow.
const GROWING = { m15_quotes: "observed_at", wx_quotes: "observed_at", wx_forecasts: "observed_at" };

const since = h => new Date(Date.now() - h * 3600000).toISOString();

console.log("STORAGE REPORT\n" + "=".repeat(66));
console.log(`${"table".padEnd(15)} ${"rows".padStart(12)} ${"est. size".padStart(11)}   last 24h`);

let totalBytes = 0, dailyBytes = 0;
const rows = [];
for (const t of TABLES) {
  const { n, err } = await count(t);
  if (err) { console.log(`${t.padEnd(15)} ${"ERROR".padStart(12)}   ${err}`); continue; }
  const w = WIDE[t];
  let wide = null;
  if (w && n) {
    const r = await count(t, w.filter, "exact");
    wide = r.n;
  }
  // A failed wide count must not read as "no wide rows" — that is the
  // silent-no-op shape this repo keeps finding. Fall back to charging
  // the whole table the wide width, which is an OVERstatement, because
  // the failure mode of a capacity estimate should be pessimism.
  const wideRows = w && n ? (wide == null ? n : wide) : 0;
  const bytes = ((n || 0) - wideRows) * (BYTES[t] || 200) + wideRows * (w ? w.bytes : 0);
  totalBytes += bytes;
  if (w && n) {
    console.log(`  ${wide == null ? "(wide count FAILED — charging every row the wide width)" :
      `of which ${fmt(wide)} ${w.note} at ~${(w.bytes / 1024).toFixed(1)}KB`}`);
  }

  let day = null;
  if (GROWING[t]) {
    const d = await count(t, `&${GROWING[t]}=gte.${since(24)}`, "exact");
    day = d.n;
    if (day != null) dailyBytes += day * (BYTES[t] || 200);
  }
  rows.push({ t, n, bytes, day });
  console.log(`${t.padEnd(15)} ${fmt(n).padStart(12)} ${gb(bytes).toFixed(3).padStart(9)} GB   ` +
              (day == null ? "—" : `+${fmt(day)}`));
}

console.log("=".repeat(66));
console.log(`${"TOTAL".padEnd(15)} ${"".padStart(12)} ${gb(totalBytes).toFixed(3).padStart(9)} GB   ` +
            `+${gb(dailyBytes).toFixed(3)} GB/day`);

console.log(`\nAgainst a ${CEILING_GB} GB ceiling:`);
const headroom = CEILING_GB - gb(totalBytes);
console.log(`  used        ${gb(totalBytes).toFixed(2)} GB  (${(100 * gb(totalBytes) / CEILING_GB).toFixed(1)}%)`);
console.log(`  headroom    ${headroom.toFixed(2)} GB`);
if (dailyBytes > 0) {
  const days = headroom / gb(dailyBytes);
  console.log(`  growth      ${gb(dailyBytes).toFixed(3)} GB/day  =  ${(gb(dailyBytes) * 365).toFixed(1)} GB/year`);
  console.log(`  runway      ${days < 0 ? "ALREADY OVER" : `${Math.round(days)} days (~${(days / 30.4).toFixed(1)} months)`}`);
  // A capacity decision made three months out is a different decision
  // from one made three weeks out, so say which this is.
  if (days < 90) console.log(`\n  ::warning::under three months of runway — this is a decision to make now`);
  else if (days < 365) console.log(`\n  Under a year. Worth deciding deliberately rather than at the ceiling.`);
  else console.log(`\n  Over a year of runway. Revisit, do not rush.`);
} else {
  console.log(`  growth      not measurable — the recorders may not have run in 24h`);
}

console.log(`\nTHE SIZE FIGURES ARE ESTIMATES, AND THEY RUN LOW. PostgREST serves`);
console.log(`row counts, not bytes. The counts above are real; the GB are rows x`);
console.log(`an assumed per-row width. Measured 2026-09-14: this report said`);
console.log(`0.269 GB and the database was 771 MB — 2.8x. Most of that gap was`);
console.log(`the markets vector, which is now counted rather than assumed; the`);
console.log(`rest is index bloat, fillfactor and the Supabase-owned schemas that`);
console.log(`pg_database_size includes and this report cannot see at all.`);
console.log(`So treat the total as a FLOOR. For the real number run`);
console.log(`supabase/queries/storage.sql in the SQL editor:`);
console.log(`https://github.com/albatrossbird/housedge/blob/main/supabase/queries/storage.sql`);
