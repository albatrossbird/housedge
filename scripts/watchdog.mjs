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

import { parseWhen } from "../lib/parseWhen.js";
import { authHeaders } from "../lib/supabaseHeaders.js";

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
  //
  // nullsLast MATCHES THE INDEX, and the coupling is the whole point of
  // the flag. `markets_updated_at_desc_idx` is DESC NULLS LAST, while a
  // bare `ORDER BY x DESC` in Postgres means DESC NULLS **FIRST** — so
  // the two orderings differ and the index cannot answer the sort. The
  // measured result was an index that WAS used and still took 1.6s:
  //
  //   Sort (top-N heapsort)  Sort Key: updated_at DESC
  //     -> Parallel Index Only Scan ... rows=101922 loops=2
  //
  // A Sort node above the scan is the tell. Reading 204,000 index
  // entries and sorting them is not what an index was added for; with
  // the orderings matched the plan is Limit -> Index Only Scan, rows=1.
  //
  // The other three tables deliberately do NOT set this: their indexes
  // are plain ascending, and a backward scan of one yields DESC NULLS
  // FIRST, which is exactly what the bare order already asks for.
  // Setting it there would break them the same way.
  { table: "markets", column: "updated_at", budget: 60 * 48,
    nullsLast: true, note: "market discovery / price refresh" },
  // THE BOX ITSELF, reporting every 5 minutes. Fifteen is three
  // intervals: long enough that one missed run is not an alarm, short
  // enough that a host which has stopped is obvious on the next check.
  //
  // This is the table that answers "is the machine alive", and it is
  // deliberately read the same way as every other: a recorder that has
  // died and a host that has died both show up as a stale timestamp,
  // so neither needs a special path to be noticed. A recorder writing
  // nothing while the box looks fine went unnoticed for fourteen hours
  // because nothing was watching the box at all.
  { table: "box_health", column: "reported_at", budget: 15,
    note: "recorder host self-report", optional: true },
];

async function newest(table, column, { nullsLast = false } = {}) {
  // One row, newest first. An index on the ordering column makes this
  // an index scan rather than the full-table sort that has twice
  // produced 57014 here — but ONLY if the index's null ordering matches
  // the one asked for here. See the note on the markets check.
  //
  // The null filter is not redundant with nullslast. Ordering decides
  // where nulls sit; the filter decides whether a null can be the
  // answer at all. Without it a single null row would make this report
  // "unparseable timestamp" forever, which is the same permanently-red
  // alarm this check was already fixed for once.
  const order = `${column}.desc${nullsLast ? ".nullslast" : ""}`;
  const r = await fetch(
    `${URL}/rest/v1/${table}?select=${column}&${column}=not.is.null&order=${order}&limit=1`, {
    headers: { ...authHeaders(KEY) },
  });
  if (!r.ok) return { at: null, err: `${r.status} ${(await r.text()).slice(0, 100)}` };
  const rows = await r.json();
  if (!rows.length) return { at: null, err: "table is EMPTY" };
  // SAY WHAT COULD NOT BE PARSED. "unparseable timestamp" names the
  // symptom and withholds the one fact needed to act on it, which is
  // the defect this whole check keeps being rewritten for — a
  // diagnostic that cannot diagnose. JSON.stringify so that null, an
  // empty string and a missing key are distinguishable from each other
  // rather than all rendering as nothing.
  const raw = rows[0][column];
  const t = parseWhen(raw);
  if (t != null) return { at: t, err: null };
  return { at: null, err: `unparseable ${column}: ${JSON.stringify(raw)?.slice(0, 60)}` +
                          ` (row keys: ${Object.keys(rows[0]).join(",") || "none"})` };
}

const mins = ms => Math.round(ms / 60000);
const ago = m => (m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`);

console.log(`WATCHDOG  ${new Date().toISOString()}\n` + "=".repeat(62));
console.log(`${"table".padEnd(15)} ${"newest".padStart(9)} ${"budget".padStart(8)}   status`);

let failed = 0, unreadable = 0;
for (const c of CHECKS) {
  const { at, err } = await newest(c.table, c.column, { nullsLast: c.nullsLast });

  // A CHECK THAT CANNOT YET PASS MUST NOT FAIL EVERY RUN. box_health
  // does not exist until 0025 is applied and holds nothing until the
  // host's first report, and a daily error nobody can clear is the
  // same failure as a counter that can only be non-zero — it teaches
  // you to ignore the channel. Once a row lands, the check is ordinary
  // and a stale one is a real alarm.
  if (c.optional && (at == null || /does not exist|PGRST20[05]|schema cache/.test(String(err || "")))) {
    console.log(`${c.table.padEnd(15)} ${"—".padStart(9)} ${ago(c.budget).padStart(8)}   `
      + `not reporting yet (${c.note}) — run supabase/migrations/0025_box_health.sql and enable marketslap-health.timer`);
    continue;
  }

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
