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

export async function pageAll(rest, table, select, filter, { key = "id", pageSize = 1000 } = {}) {
  const cols = select.split(",").map(s => s.trim());
  if (!cols.includes(key) && select !== "*") {
    throw new Error(
      `pageAll(${table}): select must include the paging key '${key}' — got '${select}'. ` +
      `Without it the cursor cannot advance and the read loops forever.`
    );
  }

  const out = [];
  let last = null;
  for (;;) {
    const q = `${table}?select=${encodeURIComponent(select)}&${filter}`
            + `&order=${key}.asc&limit=${pageSize}`
            + (last == null ? "" : `&${key}=gt.${encodeURIComponent(last)}`);
    const rows = await rest(q);
    out.push(...rows);
    if (rows.length < pageSize) return out;

    const next = rows[rows.length - 1]?.[key];
    // A FULL page that cannot advance the cursor is the infinite loop.
    // Reachable even with the key selected — a null in the column, or a
    // page whose last row repeats the previous cursor — so it is checked
    // here rather than assumed away by the guard above.
    if (next == null || next === last) {
      throw new Error(
        `pageAll(${table}): cursor did not advance at '${key}' (value ${JSON.stringify(next)}) — refusing to loop.`
      );
    }
    last = next;
  }
}
