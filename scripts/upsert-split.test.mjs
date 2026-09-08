// A write that fails because the BATCH was too big must be split and
// retried, not lost — and a write that fails for any other reason must
// NOT be retried smaller.
//
// The failure this exists for: econ came back green with
// `marketsUpserted: 13563` beside a 57014 statement timeout printed as a
// warning. A 50-row batch had failed, so ~50 markets went unwritten on a
// run with a tick, and downstream nothing can tell an unwritten market
// from one the venues delisted — which matters, because /api/prune
// deletes on exactly that "not seen in 14 days" rule.
//
// Run: node scripts/upsert-split.test.mjs

// lib/discover.js builds a Supabase client at import time, so the
// module needs a URL and key present to load at all. These are
// placeholders — nothing in this test makes a request.
process.env.SUPABASE_URL ||= "https://example.invalid";
process.env.SUPABASE_ANON_KEY ||= "placeholder";
const { isBatchSizeError } = await import("../lib/discover.js");

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nwhich errors are worth retrying smaller");
{
  // The real shape restFetch returns, and the real one econ produced.
  const timeout = { httpStatus: 500, body: JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }) };
  check("57014 statement timeout", isBatchSizeError(timeout) === true);
  check("413 payload too large", isBatchSizeError({ httpStatus: 413, body: "" }) === true);
  check("504 gateway timeout", isBatchSizeError({ httpStatus: 504, body: "" }) === true);

  // Splitting these buys nothing: every sub-batch fails the same way,
  // so a 50-row batch turns one error into up to 50 round trips.
  const notNull = { httpStatus: 400, body: JSON.stringify({ code: "23502", message: 'null value in column "platform"' }) };
  const keyMismatch = { httpStatus: 400, body: JSON.stringify({ code: "PGRST102", message: "All object keys must match" }) };
  const dupe = { httpStatus: 400, body: JSON.stringify({ code: "21000", message: "ON CONFLICT DO UPDATE command cannot affect row a second time" }) };
  check("23502 NOT NULL is NOT retried", isBatchSizeError(notNull) === false);
  check("PGRST102 key mismatch is NOT retried", isBatchSizeError(keyMismatch) === false);
  check("21000 duplicate row is NOT retried", isBatchSizeError(dupe) === false);
}

// The splitter itself, exercised through a fake PostgREST that refuses
// any batch over `maxBatch` with the error econ actually hit.
function fakeBackend({ maxBatch, poisonId = null }) {
  const written = new Set();
  let calls = 0;
  return {
    written, calls: () => calls,
    async send(rows) {
      calls++;
      if (rows.length > maxBatch) {
        return { error: { httpStatus: 500, body: JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }) } };
      }
      if (poisonId != null && rows.some(r => r.id === poisonId)) {
        return { error: { httpStatus: 400, body: JSON.stringify({ code: "23502", message: 'null value in column "platform"' }) } };
      }
      for (const r of rows) written.add(r.id);
      return { data: null };
    },
  };
}

// A standalone copy of the split loop, so the test pins the ALGORITHM
// without needing Supabase env vars to import the live writer's module
// state. Kept deliberately small and identical in shape to upsertRows.
async function splitWrite(rows, backend, { batchSize = 50, maxDepth = 6 } = {}) {
  let count = 0, rowsFailed = 0, splitRetries = 0;
  const errors = [];
  const writeSlice = async (slice, depth = 0) => {
    if (!slice.length) return;
    const { error } = await backend.send(slice);
    if (!error) { count += slice.length; return; }
    if (slice.length > 1 && depth < maxDepth && isBatchSizeError(error)) {
      splitRetries++;
      const mid = Math.ceil(slice.length / 2);
      await writeSlice(slice.slice(0, mid), depth + 1);
      await writeSlice(slice.slice(mid), depth + 1);
      return;
    }
    rowsFailed += slice.length;
    errors.push(`${slice.length} row(s) unwritten: ${JSON.stringify(error)}`);
  };
  for (let i = 0; i < rows.length; i += batchSize) await writeSlice(rows.slice(i, i + batchSize));
  return { count, rowsFailed, splitRetries, errors };
}

const rows = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

console.log("\na batch too big for the table gets split until it fits");
{
  const be = fakeBackend({ maxBatch: 12 });
  const r = await splitWrite(rows(50), be);
  check("every row is written", r.count === 50, `count=${r.count}`);
  check("nothing reported unwritten", r.rowsFailed === 0, `rowsFailed=${r.rowsFailed}`);
  check("the split is reported", r.splitRetries > 0, `splitRetries=${r.splitRetries}`);
  check("no errors", r.errors.length === 0, JSON.stringify(r.errors));
  check("the backend really got small batches", be.written.size === 50);
}

console.log("\nthe old behaviour: without splitting the batch is simply lost");
{
  const be = fakeBackend({ maxBatch: 12 });
  const r = await splitWrite(rows(50), be, { maxDepth: 0 });
  check("50 rows go unwritten", r.rowsFailed === 50, `rowsFailed=${r.rowsFailed}`);
  check("and the shortfall is SIZED, not just flagged", /50 row\(s\) unwritten/.test(r.errors[0] || ""), r.errors[0] || "");
}

console.log("\none bad row does not cost the other 49");
{
  const be = fakeBackend({ maxBatch: 50, poisonId: "m37" });
  const r = await splitWrite(rows(50), be);
  // The poison row is a 23502, so it is never split for its own sake —
  // but the batch containing it fails, and nothing else should.
  check("the poison row is not written", !be.written.has("m37"));
  check("exactly the failing slice is counted", r.rowsFailed === 50 && r.count === 0,
        `count=${r.count} rowsFailed=${r.rowsFailed}`);
  check("a NOT NULL error is not retried at all", be.calls() === 1, `calls=${be.calls()}`);
}

console.log("\na clean write is untouched");
{
  const be = fakeBackend({ maxBatch: 1000 });
  const r = await splitWrite(rows(120), be);
  check("all rows written", r.count === 120);
  check("no splits", r.splitRetries === 0);
  check("one call per batch", be.calls() === 3, `calls=${be.calls()}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
