// Deduping an upsert batch on its conflict target.
//
// Postgres refuses a statement that names the same row twice --
//   21000  ON CONFLICT DO UPDATE command cannot affect row a second time
// -- and PostgREST fails the WHOLE batch, so fifty markets go unwritten
// while `marketsUpserted` simply reports a smaller number. Econ hit this
// on its first runner-based run because its Polymarket side is five
// overlapping tags and a Fed market carrying two of them is fetched
// twice and concatenated.
//
// The function is copied verbatim rather than imported because
// lib/discover.js pulls in supabase-js and the whole discovery module.
function dedupeOnConflict(rows, onConflict) {
  const keys = String(onConflict || "id").split(",").map(k => k.trim()).filter(Boolean);
  const seen = new Map();
  for (const r of rows) seen.set(keys.map(k => String(r?.[k])).join("\u0000"), r);
  return seen.size === rows.length ? rows : [...seen.values()];
}

let bad = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { bad++; console.error("FAIL " + what + " | got: " + g + " | want: " + w); }
};

{
  const rows = [{ id: "x", v: 1 }, { id: "y", v: 2 }, { id: "x", v: 3 }];
  const d = dedupeOnConflict(rows, "id");
  eq(d.length, 2, "a duplicated id collapses");
  // LAST WINS: later sources in the concatenation are the more specific
  // ones, and it matches what Postgres would do had the rows arrived as
  // separate statements.
  eq(d.find(r => r.id === "x").v, 3, "the last occurrence wins");
  eq(d.map(r => r.id), ["x", "y"], "surviving rows keep first-seen order");
}
{
  // The pairs table conflicts on TWO columns, so keying on "id" alone
  // would collapse rows that are genuinely distinct.
  const rows = [
    { kalshi_id: "a", polymarket_id: "1" },
    { kalshi_id: "a", polymarket_id: "2" },
    { kalshi_id: "a", polymarket_id: "1" },
  ];
  eq(dedupeOnConflict(rows, "kalshi_id,polymarket_id").length, 2, "composite target keeps distinct pairs");
  eq(dedupeOnConflict(rows, "kalshi_id").length, 1, "and a single-column target would NOT have");
}
{
  // No duplicates must cost nothing -- the same array back, not a copy.
  const clean = [{ id: "a" }, { id: "b" }];
  eq(dedupeOnConflict(clean, "id") === clean, true, "a clean batch is passed through untouched");
  eq(dedupeOnConflict([], "id").length, 0, "empty batch");
}
{
  // Ids differing only by type must not survive as two rows: markets.id
  // is a text PK, so 1 and "1" are the same row to Postgres.
  eq(dedupeOnConflict([{ id: 1 }, { id: "1" }], "id").length, 1, "numeric and string id are one row");
  // An absent key collapses everything into one, which is why the
  // conflict target has to be passed and never guessed.
  eq(dedupeOnConflict([{ id: "a" }, { id: "b" }], "nope").length, 1, "an absent key collapses everything");
}

console.log(bad ? bad + " failing" : "upsert-dedupe: all cases pass");
process.exit(bad ? 1 : 0);
