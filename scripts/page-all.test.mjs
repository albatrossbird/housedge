// The pager under fetchAllRows, tested against a fake PostgREST builder.
//
// This is worth pinning because the bug it fixes was INVISIBLE: the read
// paged with .range() and no ORDER BY, Postgres makes no promise about
// row order without one, and consecutive pages could therefore skip rows
// outright. A skipped row reads as "never embedded", so it was bought
// from Voyage again — 10 of crypto's 1,200 on the run that caught it,
// with no truncation reported and every counter healthy.
let bad = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { bad++; console.error(`FAIL ${what}\n  got:  ${g}\n  want: ${w}`); }
};

// A stand-in for the query builder: records order/limit/gt and serves
// rows from a table. `shuffle` models the thing that actually bites —
// a backend free to return an unstable order when not asked for one.
function fakeTable(rows, { shuffle = false } = {}) {
  return function build() {
    const st = { key: null, asc: true, limit: null, gt: null };
    const q = {
      order(k, o) { st.key = k; st.asc = o?.ascending !== false; return q; },
      limit(n) { st.limit = n; return q; },
      gt(k, v) { st.gt = [k, v]; return q; },
      then(res) {
        let out = rows.slice();
        if (st.key) out.sort((a, b) => (a[st.key] > b[st.key] ? 1 : a[st.key] < b[st.key] ? -1 : 0));
        else if (shuffle) out.reverse();
        if (st.gt) out = out.filter(r => r[st.gt[0]] > st.gt[1]);
        if (st.limit != null) out = out.slice(0, st.limit);
        res({ data: out, error: null });
      },
    };
    return q;
  };
}

// The pager, mirroring fetchAllRows. Kept in the test rather than
// imported because embed.js is a Next route that pulls in Supabase.
async function pageAll(buildQuery, { pageSize = 1000, maxRows = 60000, errors = null, key = "id" } = {}) {
  const out = [];
  let size = pageSize, last = null;
  while (out.length < maxRows) {
    let q = buildQuery().order(key, { ascending: true }).limit(size);
    if (last != null) q = q.gt(key, last);
    const { data, error } = await q;
    if (error) {
      if (size > 100) { size = Math.floor(size / 2); continue; }
      if (errors) errors.push(String(error.message || error));
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    last = data[data.length - 1][key];
    if (last == null) { if (errors) errors.push(`key "${key}" missing`); break; }
  }
  return out;
}

const mk = n => Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(5, "0")}`, v: i }));

{
  // Every row exactly once, across many pages.
  const rows = mk(2500);
  const got = await pageAll(fakeTable(rows), { pageSize: 100 });
  eq(got.length, 2500, "reads every row");
  eq(new Set(got.map(r => r.id)).size, 2500, "no row read twice");
  eq(got[0].id, "m00000", "starts at the first key");
  eq(got[got.length - 1].id, "m02499", "ends at the last key");
}
{
  // The actual failure: a backend returning an unstable order. Keyset
  // is immune because it seeks by key rather than counting from the
  // start, so this must still read all 2,500.
  const rows = mk(2500);
  const got = await pageAll(fakeTable(rows, { shuffle: true }), { pageSize: 100 });
  eq(got.length, 2500, "unstable backend order loses nothing");
  eq(new Set(got.map(r => r.id)).size, 2500, "unstable backend order duplicates nothing");
}
{
  // Exact multiple of the page size must not loop or double-read.
  const got = await pageAll(fakeTable(mk(300)), { pageSize: 100 });
  eq(got.length, 300, "exact multiple of page size");
  eq(new Set(got.map(r => r.id)).size, 300, "exact multiple, no duplicates");
}
{
  eq((await pageAll(fakeTable([]), { pageSize: 100 })).length, 0, "empty table");
  eq((await pageAll(fakeTable(mk(1)), { pageSize: 100 })).length, 1, "single row");
}
{
  // A key that is not on the row would page the same window forever.
  const errs = [];
  const got = await pageAll(fakeTable(mk(300)), { pageSize: 100, key: "nope", errors: errs });
  eq(got.length <= 300, true, "missing key does not loop");
  eq(errs.length > 0, true, "missing key is reported, not swallowed");
}
{
  // maxRows stops the read; the caller is told it is a truncation
  // elsewhere. Here: it must stop rather than run away.
  const got = await pageAll(fakeTable(mk(5000)), { pageSize: 100, maxRows: 250 });
  eq(got.length >= 250 && got.length <= 350, true, "maxRows bounds the read");
}

console.log(bad ? `${bad} failing` : "page-all: all cases pass");
process.exit(bad ? 1 : 0);
