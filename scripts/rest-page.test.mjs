// The shared PostgREST pager.
//
// Worth pinning because the bug it exists to stop was INVISIBLE: paging
// on a key that is not in the SELECT makes row[key] undefined, so the
// cursor never advances and the same first page returns forever. It
// presents as a slow query rather than an error. The live run that found
// it sat in GitHub Actions re-reading one page until it was cancelled,
// with nothing in the log to say why.
import { pageAll } from "../lib/restPage.js";

let bad = 0;
const ok = (cond, what) => { if (cond) console.log(`  ok  ${what}`); else { bad++; console.error(`FAIL ${what}`); } };
const threw = async (fn, match, what) => {
  try { await fn(); bad++; console.error(`FAIL ${what} — did not throw`); }
  catch (e) {
    if (String(e.message).includes(match)) console.log(`  ok  ${what}`);
    else { bad++; console.error(`FAIL ${what} — wrong error: ${e.message}`); }
  }
};

// A backend that pages honestly, so the happy path is real paging and
// not a single short read.
const rows = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, v: `r${i + 1}` }));
const backend = (calls) => async (q) => {
  calls.push(q);
  const size = Number(q.match(/limit=(\d+)/)[1]);
  const gt = q.match(/id=gt\.(\d+)/);
  const from = gt ? Number(gt[1]) : 0;
  return rows.filter(r => r.id > from).slice(0, size);
};

console.log("it pages to the end and returns every row exactly once");
{
  const calls = [];
  const got = await pageAll(backend(calls), "t", "id,v", "x=eq.1");
  ok(got.length === 2500, `all 2500 rows (got ${got.length})`);
  ok(new Set(got.map(r => r.id)).size === 2500, "no duplicates");
  ok(calls.length === 3, `three pages at the default size (got ${calls.length})`);
  ok(calls[0].includes("order=id.asc"), "ordered by the key — the ORDER BY this repo kept omitting");
  ok(!calls[0].includes("id=gt."), "no cursor on the first page");
  ok(calls[1].includes("id=gt.1000"), "the second page resumes from the first page's last id");
}

console.log("\nthe key must be in the SELECT — the live infinite loop");
{
  // This is the exact call that hung: the pager defaults to id and the
  // caller asked for two other columns.
  await threw(
    () => pageAll(backend([]), "m15_quotes", "ticker,source", "observed_at=gte.x"),
    "must include the paging key",
    "a select without the key is refused BEFORE any request is made",
  );
  const got = await pageAll(backend([]), "t", "*", "x=eq.1");
  ok(Array.isArray(got), "select=* is allowed — every column includes the key");
}

console.log("\na full page that cannot advance is refused, not retried");
{
  // Reachable with the key selected: a null in the column, or a backend
  // that keeps returning the same last row.
  const stuck = async (q) => Array.from({ length: 1000 }, (_, i) => ({ id: 7, v: i }));
  await threw(
    () => pageAll(stuck, "t", "id,v", "x=eq.1"),
    "cursor did not advance",
    "a repeated cursor throws instead of looping",
  );
  const nulls = async () => Array.from({ length: 1000 }, () => ({ id: null }));
  await threw(
    () => pageAll(nulls, "t", "id", "x=eq.1"),
    "cursor did not advance",
    "a null key throws instead of looping",
  );
}

console.log("\na short page ends the read, and a non-default key works");
{
  const one = async () => [{ ticker: "A" }];
  const got = await pageAll(one, "t", "ticker", "x=eq.1", { key: "ticker" });
  ok(got.length === 1, "a page under the limit is the last page");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
