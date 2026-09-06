// Pull the SETTLED history of Kalshi's 15-minute markets.
//
// This exists because the outcome half of the dataset is not perishable
// and does not have to be waited for: Kalshi keeps settled markets
// queryable with their `result`, and KXBTC15M alone returns 6,458 of
// them back to 2026-06-30. So the base rates, the volume profile and
// the settlement distribution are all available on day one — only the
// intra-window price path has to be recorded going forward.
//
// Runs in GitHub Actions, not Vercel: this pages thousands of markets
// per series and writes thousands of rows, which is neither a 300s job
// nor something to spend the Hobby plan's 4 CPU-hours/month on.
import { listM15Series, kalshiGet, toM15Row } from "../lib/m15.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const MAX_PAGES = Number(process.env.M15_MAX_PAGES || 12);
const CHUNK = 500;

if (!SUPABASE_URL || !KEY) {
  console.error("::error::SUPABASE_URL and a key are required");
  process.exit(1);
}
// Say which credential is in use. Anon cannot write through the RLS
// policy in 0016, so a run that "succeeded" with zero rows written is
// otherwise indistinguishable from a run with nothing to write.
console.log(`credential: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon (writes will be REJECTED by RLS)"}`);

async function upsert(table, rows, onConflict) {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) {
      console.error(`::error::${table} upsert ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return { written, failed: true };
    }
    written += chunk.length;
  }
  return { written, failed: false };
}

const { series, errors } = await listM15Series();
errors.forEach(e => console.log(`::warning::series list: ${e}`));
if (!series.length) { console.error("::error::no 15-minute series found"); process.exit(1); }
console.log(`15-minute series: ${series.length}`);

let totalRows = 0, failed = false;
const perSeries = [];

for (const s of series) {
  const rows = [];
  let cursor = "";
  let pages = 0;
  let truncated = false;
  for (; pages < MAX_PAGES; pages++) {
    const q = `/markets?status=settled&limit=1000&series_ticker=${encodeURIComponent(s.ticker)}` +
              (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await kalshiGet(q);
    if (!r.ok) { console.log(`::warning::${s.ticker} page ${pages}: ${r.status || r.error}`); break; }
    const got = r.body.markets || [];
    for (const m of got) { const row = toM15Row(m, s.ticker); if (row) rows.push(row); }
    cursor = r.body.cursor || "";
    if (!cursor || got.length === 0) break;
  }
  // A cap hit is a truncation, not an answer — the lesson fetchAllRows
  // had to learn twice. Say so rather than reporting a smaller number.
  if (cursor && pages >= MAX_PAGES) truncated = true;

  if (rows.length) {
    const res = await upsert("m15_markets", rows, "ticker");
    if (res.failed) failed = true;
    totalRows += res.written;
  }
  perSeries.push({ ticker: s.ticker, rows: rows.length, pages, truncated });
  console.log(`  ${s.ticker.padEnd(18)} settled=${String(rows.length).padStart(5)} pages=${pages}${truncated ? " TRUNCATED" : ""}`);
  if (truncated) console.log(`::warning::${s.ticker} hit the ${MAX_PAGES}-page cap; older history was not read`);
}

console.log(`\nseries=${series.length} rowsWritten=${totalRows}`);
if (failed) { console.error("::error::at least one upsert failed"); process.exit(1); }
if (totalRows === 0) { console.error("::error::no rows written — a backfill that writes nothing is not a success"); process.exit(1); }
