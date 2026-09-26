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


// ---------------------------------------------------------------------
// Paging on a key that REPEATS.
//
// This mode exists because the column you must page on is usually not
// unique. m15_quotes is filtered by `ticker IN (...)` against an index
// on (ticker, observed_at), so `ticker` is the only key that lets
// Postgres walk the index instead of sorting a million rows — and a
// ticker carries ~75 quotes.
//
// Ordering by the primary key instead is what broke the analysis
// tooling: seven scripts paged on `id` while filtering on `ticker`, and
// every one of them started returning 57014 once the table outgrew the
// statement timeout.

console.log("\npaging on a key that repeats");
{
  // Three tickers, four quotes each, page size 5 — so every page
  // boundary lands mid-ticker, which is the case `gt` gets wrong.
  const rows = [];
  for (const t of ["AAA", "BBB", "CCC"]) for (let i = 0; i < 4; i++) rows.push({ id: `${t}-${i}`, ticker: t });

  const serve = (q) => {
    const m = /ticker=(gte?)\.([^&]+)/.exec(q);
    let out = rows;
    if (m) out = rows.filter(r => (m[1] === "gt" ? r.ticker > decodeURIComponent(m[2]) : r.ticker >= decodeURIComponent(m[2])));
    const lim = Number(/limit=(\d+)/.exec(q)[1]);
    return out.slice(0, lim);
  };

  const got = await pageAll(async q => serve(q), "m15_quotes", "id,ticker", "x=1",
                            { key: "ticker", pageSize: 5, dedupeOn: "id" });
  ok(got.length === 12, "every row is returned");
  ok(new Set(got.map(r => r.id)).size === 12, "and none is returned twice");

  // THE BUG THIS REPLACES: `gt` on a repeating key drops the rest of
  // whichever ticker the page boundary fell inside.
  const withGt = await pageAll(async q => serve(q), "m15_quotes", "id,ticker", "x=1",
                               { key: "ticker", pageSize: 5 });
  ok(withGt.length < 12, `a gt cursor on a repeating key LOSES rows (got ${withGt.length} of 12)`);
}

console.log("\nand it still refuses to spin");
{
  // One ticker with more rows than a page. Under gte the cursor cannot
  // move and every page is the same page — so it must throw, not loop.
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `Z-${i}`, ticker: "ZZZ" }));
  let threw = null;
  try {
    await pageAll(async q => rows.slice(0, Number(/limit=(\d+)/.exec(q)[1])),
                  "m15_quotes", "id,ticker", "x=1", { key: "ticker", pageSize: 3, dedupeOn: "id" });
  } catch (e) { threw = e; }
  ok(threw, "a key value larger than a page throws");
  ok(/did not advance/.test(String(threw?.message)), "and says the cursor did not advance");
}

console.log("\nthe dedupe column must be selected too");
{
  let threw = null;
  try {
    await pageAll(async () => [], "m15_quotes", "ticker,yes_bid", "x=1",
                  { key: "ticker", dedupeOn: "id" });
  } catch (e) { threw = e; }
  ok(threw && /dedupe column/.test(String(threw.message)),
     "an unselected dedupe column is refused before any request");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
