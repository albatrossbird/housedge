// Keyset paging over PostgREST.
//
// WHY THIS IS SHARED RATHER THAN WRITTEN AGAIN. This repo has been bitten
// four times by a pager:
//
//   - `.range()` with no ORDER BY, which Postgres makes no promise about,
//     so consecutive pages could overlap or SKIP rows. A skipped row read
//     as "never embedded" and was bought from Voyage a second time.
//   - OFFSET paging in prune, O(n^2) because Postgres scans and discards
//     every row before the window, so the LAST pages are the slowest and
//     a table that worked for months began timing out as it grew.
//   - The same OFFSET shape in the refresh job's pairs read.
//   - And the one this file exists to make impossible: paging on a key
//     that was not in the SELECT. `row[key]` is undefined, the cursor
//     never advances, and the same first page comes back FOREVER. It
//     presents as a slow query, not as an error, so it runs until
//     something kills it.
//
// The cure for the last two is the same: make the wrong call fail at
// once, loudly, instead of degrading into something that looks like
// latency.

// `dedupeOn` PAGES ON A COLUMN THAT REPEATS, and exists because the
// index you must page on is often not unique.
//
// The rule this module already enforces is "page on the key, filter on
// the key" — order by a column the filter can use, or Postgres sorts
// the whole matching set instead of walking an index. On m15_quotes the
// filter is `ticker IN (...)` and the index is (ticker, observed_at),
// so the correct paging key is `ticker`. A ticker carries ~75 quotes.
//
// A `gt` cursor would then SKIP every row sharing the last ticker of a
// page. So with `dedupeOn` the cursor becomes `gte` — re-reading that
// boundary — and rows already returned are dropped by the column named,
// which must be genuinely unique (a primary key). Same shape as
// m15-coverage's window read, which takes `gte` because twenty-six
// series share a close_time.
//
// The stall guard still holds and gets STRICTER: with `gte`, a full
// page that yields no new rows at all means one key value has more rows
// than a page and the cursor can never move, so it throws rather than
// spinning — the failure this module was written to make impossible.
export async function pageAll(rest, table, select, filter, { key = "id", pageSize = 1000, dedupeOn = null } = {}) {
  const cols = select.split(",").map(s => s.trim());
  if (!cols.includes(key) && select !== "*") {
    throw new Error(
      `pageAll(${table}): select must include the paging key '${key}' — got '${select}'. ` +
      `Without it the cursor cannot advance and the read loops forever.`
    );
  }

  if (dedupeOn && !cols.includes(dedupeOn) && select !== "*") {
    throw new Error(
      `pageAll(${table}): select must include the dedupe column '${dedupeOn}' — got '${select}'. ` +
      `Without it the re-read boundary cannot be filtered and rows would be duplicated.`
    );
  }

  const out = [];
  const seen = dedupeOn ? new Set() : null;
  let last = null;
  for (;;) {
    const op = dedupeOn && last != null ? "gte" : "gt";
    const q = `${table}?select=${encodeURIComponent(select)}&${filter}`
            + `&order=${key}.asc&limit=${pageSize}`
            + (last == null ? "" : `&${key}=${op}.${encodeURIComponent(last)}`);
    const rows = await rest(q);

    let fresh = 0;
    for (const r of rows) {
      if (seen) {
        const id = r[dedupeOn];
        if (seen.has(id)) continue;
        seen.add(id);
      }
      out.push(r);
      fresh++;
    }
    if (rows.length < pageSize) return out;

    const next = rows[rows.length - 1]?.[key];
    // A FULL page that cannot advance the cursor is the infinite loop.
    // Reachable even with the key selected — a null in the column, or a
    // page whose last row repeats the previous cursor — so it is checked
    // here rather than assumed away by the guard above.
    //
    // Under `gte` the cursor is ALLOWED to repeat (that is the point),
    // so what proves progress there is new ROWS. A full page of rows
    // already seen means one key value exceeds a page and re-reading it
    // returns the same page forever.
    if (next == null || (dedupeOn ? fresh === 0 : next === last)) {
      throw new Error(
        `pageAll(${table}): cursor did not advance at '${key}' (value ${JSON.stringify(next)}) — refusing to loop.`
      );
    }
    last = next;
  }
}
