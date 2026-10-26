// Pull the SETTLED history of Kalshi's 15-minute markets.
//
// This exists because the outcome half of the dataset is not perishable
// and does not have to be waited for: Kalshi keeps settled markets
// queryable with their `result`, and KXBTC15M alone returns 6,458 of
// them back to 2026-06-30. So the base rates, the volume profile and
// the settlement distribution are all available on day one — only the
// intra-window price path has to be recorded going forward.
//
// It also keeps the price each window SETTLED at (m15_settlements,
// migration 0032) for the recorded series and the commodity and FX ones
// (lib/m15.js M15_EXTRA_SERIES): Pyth's value at every close, the
// yardstick for any cheaper feed. Those nine are not written to
// m15_markets, whose readers count every window in it.
//
// Runs in GitHub Actions, not Vercel: this pages thousands of markets
// per series and writes thousands of rows, which is neither a 300s job
// nor something to spend the Hobby plan's 4 CPU-hours/month on.
import { listM15Series, kalshiGet, toM15Row, toM15Settlement, m15InScope, m15InExtra } from "../lib/m15.js";
import { authHeaders } from "../lib/supabaseHeaders.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
// KXBTC15M passed 11,000 settled windows in October; at 12 pages it was
// about to be cut short, and the warning below would have said so daily.
const MAX_PAGES = Number(process.env.M15_MAX_PAGES || 30);
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
        ...authHeaders(KEY),
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      // A migration not yet run costs that table, never the run: the
      // markets half is unaffected by it.
      if (table === "m15_settlements" && (r.status === 404 || /PGRST205|42P01|m15_settlements/.test(body))) {
        return { written, failed: false, missing: body };
      }
      console.error(`::error::${table} upsert ${r.status}: ${body}`);
      return { written, failed: true };
    }
    written += chunk.length;
  }
  return { written, failed: false };
}

const inScope = m15InScope(), inExtra = m15InExtra();
const { series, outOfScope, errors } = await listM15Series({ inScope: t => inScope(t) || inExtra(t) });
errors.forEach(e => console.log(`::warning::series list: ${e}`));
if (outOfScope.length) console.log(`out of scope (lib/m15.js), not read: ${outOfScope.join(" ")}`);
if (!series.length) { console.error("::error::no 15-minute series found"); process.exit(1); }
console.log(`15-minute series: ${series.length} (settlement prices only: ${series.filter(s => !inScope(s.ticker)).map(s => s.ticker).join(" ") || "none"})`);

let totalRows = 0, failed = false, settled = 0, settlementsMissing = null;
const perSeries = [];

for (const s of series) {
  const rows = [], sets = [];
  let cursor = "";
  // PAGES READ, not loop iterations completed. `for (; pages < MAX; pages++)`
  // left this at 0 for a series that fitted in one page, so copper
  // reported `settled=628 pages=0` — a counter contradicting the number
  // beside it, which is worse than no counter.
  let pages = 0;
  let truncated = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = `/markets?status=settled&limit=1000&series_ticker=${encodeURIComponent(s.ticker)}` +
              (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await kalshiGet(q);
    if (!r.ok) { console.log(`::warning::${s.ticker} page ${pages}: ${r.status || r.error}`); break; }
    pages++;
    const got = r.body.markets || [];
    for (const m of got) {
      const row = toM15Row(m, s.ticker); if (row && inScope(s.ticker)) rows.push(row);
      const st = toM15Settlement(m, s.ticker); if (st) sets.push(st);
    }
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
  if (sets.length && !settlementsMissing) {
    const res = await upsert("m15_settlements", sets, "ticker");
    if (res.failed) failed = true;
    if (res.missing) settlementsMissing = res.missing;
    settled += res.written;
  }
  const n = Math.max(rows.length, sets.length);
  perSeries.push({ ticker: s.ticker, rows: n, pages, truncated });
  // A series with no settled markets is usually NOT a failure: Kalshi
  // registers a series before it ever trades, so 11 of the 26 return
  // nothing in ANY status — the state KXNHLGAME sits in out of season.
  // Labelled, so it does not read as a broken fetch.
  const note = n === 0 ? "  (not yet listed)" : truncated ? "  TRUNCATED" : "";
  console.log(`  ${s.ticker.padEnd(18)} settled=${String(n).padStart(5)} values=${String(sets.length).padStart(5)} pages=${pages}${inScope(s.ticker) ? "" : "  (settlement prices only)"}${note}`);
  if (truncated) console.log(`::warning::${s.ticker} hit the ${MAX_PAGES}-page cap; older history was not read`);
}

const withData = perSeries.filter(p => p.rows > 0).length;
console.log(`\nseries=${series.length} withHistory=${withData} notYetListed=${series.length - withData} rowsWritten=${totalRows} settlementsWritten=${settled}`);
if (settlementsMissing) console.log(`::warning::m15_settlements is not there yet — run supabase/migrations/0032_m15_settlements.sql (${settlementsMissing.slice(0, 120)})`);
if (failed) { console.error("::error::at least one upsert failed"); process.exit(1); }
if (totalRows === 0) { console.error("::error::no rows written — a backfill that writes nothing is not a success"); process.exit(1); }
