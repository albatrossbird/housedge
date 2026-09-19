// Halving a failed upsert chunk, and naming what still fails.
//
// MEASURED across six consecutive refresh runs: exactly one chunk of
// ~48 failed with `57014 canceling statement due to statement timeout`,
// every time. Random IO pressure varies; a constant of one says the
// SAME rows fail every run — so ~100 markets were never refreshing and
// their prices were frozen, which is the stale-price bug this job
// exists to prevent. The error read only `upsert: {...}` and named none
// of them, so nothing could say which markets were stale.
//
// The function under test is the recursive splitter; it is exercised
// here against fake senders rather than a database.
let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

// Mirror of sendSplitting in lib/refreshPrices.js.
async function sendSplitting(rows, send) {
  const { error } = await send(rows);
  if (!error) return { written: rows.length, failed: [], error: null };
  if (rows.length === 1) return { written: 0, failed: [rows[0].id], error };
  const mid = Math.ceil(rows.length / 2);
  const a = await sendSplitting(rows.slice(0, mid), send);
  const b = await sendSplitting(rows.slice(mid), send);
  return { written: a.written + b.written, failed: [...a.failed, ...b.failed], error: a.error || b.error };
}

const rows = n => Array.from({ length: n }, (_, i) => ({ id: `M${i}` }));

console.log("a clean batch is written in ONE call, not split");
{
  let calls = 0;
  const r = await sendSplitting(rows(100), async () => { calls++; return { error: null }; });
  ok(r.written === 100 && !r.failed.length, "all 100 written");
  ok(calls === 1, `one request, not 100 (got ${calls})`);
}

console.log("\none pathological row is isolated, the other 99 land");
{
  // The live shape: a single row makes the statement time out, so every
  // batch containing it fails and every batch without it succeeds.
  const poison = "M57";
  const r = await sendSplitting(rows(100), async batch =>
    batch.some(x => x.id === poison) ? { error: { code: "57014" } } : { error: null });
  ok(r.written === 99, `99 rows recovered (got ${r.written})`);
  ok(r.failed.length === 1 && r.failed[0] === poison, `the culprit is named: ${r.failed[0]}`);
  ok(r.error && r.error.code === "57014", "and the original error is carried up");
}

console.log("\na transient failure passes on the retry");
{
  // Timeouts under IO pressure are not row-specific. The first whole-
  // chunk attempt fails; the halves succeed.
  let first = true;
  const r = await sendSplitting(rows(40), async () => {
    if (first) { first = false; return { error: { code: "57014" } }; }
    return { error: null };
  });
  ok(r.written === 40 && !r.failed.length, "everything written after one split");
}

console.log("\na wholly broken write names every row rather than a count");
{
  const r = await sendSplitting(rows(8), async () => ({ error: { code: "57014" } }));
  ok(r.written === 0, "nothing written");
  ok(r.failed.length === 8, "all eight named");
  // A count alone cannot tell you WHICH market froze, which is the
  // whole reason this failed silently for as long as it did.
  ok(r.failed.every(id => /^M\d+$/.test(id)), "as ids, not as a number");
}

console.log("\ntwo culprits in one chunk are both found");
{
  const poisons = new Set(["M3", "M62"]);
  const r = await sendSplitting(rows(100), async batch =>
    batch.some(x => poisons.has(x.id)) ? { error: { code: "57014" } } : { error: null });
  ok(r.written === 98, `98 recovered (got ${r.written})`);
  ok(r.failed.sort().join(",") === "M3,M62", `both named: ${r.failed.join(",")}`);
}

console.log("\na single row that fails is not split further");
{
  let calls = 0;
  const r = await sendSplitting(rows(1), async () => { calls++; return { error: { code: "57014" } }; });
  ok(calls === 1 && r.failed.length === 1, "one attempt, one named failure, no recursion");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
