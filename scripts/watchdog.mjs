// Is anything still writing?
//
// WHY THIS EXISTS. Once the recorders move off GitHub Actions, a dead
// box produces no red workflow — it produces silence, and silence is
// indistinguishable from a quiet market until someone goes looking. The
// price path cannot be backfilled, so a week of unnoticed downtime is a
// week destroyed. This keeps failure visible through the channel that
// is already watched, from a phone, without SSH.
//
// THE DATA IS ITS OWN HEARTBEAT, and that is deliberate rather than
// convenient. A separate "I am alive" ping would report a process that
// is running and writing nothing — which is exactly the failure this
// project keeps finding: green counters over an empty write. Reading
// max(observed_at) from the tables themselves tests the thing that
// actually matters.
//
// IT ALSO WORKS TODAY, unchanged, against the Actions recorders. The
// watchdog is not waiting on the migration; it is a better alarm than
// the one we have either way.
//
// Reads only, anon key. Writes nothing. Exits non-zero when stale.

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL || !KEY) { console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY not set"); process.exit(2); }

// Staleness budgets, in minutes. Each is set from what the job
// actually promises, not from a round number — an alarm that fires on
// normal operation gets ignored, and an alarm that cannot fire is
// worse than none.
const CHECKS = [
  // Recorders write continuously; an hour of silence is a fault.
  { table: "m15_quotes", column: "observed_at", budget: 60,
    note: "15-minute recorder" },
  { table: "wx_quotes", column: "observed_at", budget: 60,
    note: "weather recorder" },
  // Forecasts are fetched on an hourly clock inside the recorder loop,
  // so they get a wider budget than the quotes beside them.
  { table: "wx_forecasts", column: "observed_at", budget: 180,
    note: "NWS forecast fetch" },
  // Discovery and matching are daily; two days of silence means a run
  // failed rather than that nothing changed.
  { table: "markets", column: "updated_at", budget: 60 * 48,
    note: "market discovery / price refresh" },
];

async function newest(table, column) {
  // One row, newest first. An index on the ordering column makes this
  // an index scan rather than the full-table sort that has twice
  // produced 57014 here.
  const r = await fetch(`${URL}/rest/v1/${table}?select=${column}&order=${column}.desc&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return { at: null, err: `${r.status} ${(await r.text()).slice(0, 100)}` };
  const rows = await r.json();
  if (!rows.length) return { at: null, err: "table is EMPTY" };
  const t = Date.parse(rows[0][column]);
  return Number.isFinite(t) ? { at: t, err: null } : { at: null, err: "unparseable timestamp" };
}

const mins = ms => Math.round(ms / 60000);
const ago = m => (m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`);

console.log(`WATCHDOG  ${new Date().toISOString()}\n` + "=".repeat(62));
console.log(`${"table".padEnd(15)} ${"newest".padStart(9)} ${"budget".padStart(8)}   status`);

let failed = 0, unreadable = 0;
for (const c of CHECKS) {
  const { at, err } = await newest(c.table, c.column);
  if (err) {
    // A read that FAILS is not a table that is fresh. Saying "unknown"
    // rather than passing is the whole point — this repo has been
    // bitten by a diagnostic that could not report its own failure.
    unreadable++;
    console.log(`${c.table.padEnd(15)} ${"?".padStart(9)} ${(ago(c.budget)).padStart(8)}   ::error::UNREADABLE — ${err}`);
    continue;
  }
  const age = mins(Date.now() - at);
  const stale = age > c.budget;
  if (stale) failed++;
  console.log(`${c.table.padEnd(15)} ${ago(age).padStart(9)} ${ago(c.budget).padStart(8)}   ` +
              (stale ? `::error::STALE — ${c.note} has not written in ${ago(age)}` : `ok  (${c.note})`));
}

console.log("=".repeat(62));
if (failed || unreadable) {
  console.error(`\n::error::${failed} stale, ${unreadable} unreadable.`);
  console.error(`The price path CANNOT be backfilled — a settled market reports only`);
  console.error(`its last price, and candle data sits inside the recorded book just`);
  console.error(`11.4% of the time. Every window missed while this is red is gone.`);
  process.exit(1);
}
console.log("\nall writers fresh");
