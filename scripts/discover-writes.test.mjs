// The discovery run's write order, and what the markets write carries.
//
// THE ALARM THAT COULD NOT BE CLEARED. Politics failed every day for at
// least five days (2026-09-24..28) on
//
//   politics: 2 rows were about to be re-embedded — needsEmbedding is
//   reading a stale or truncated set        asked=11 embedded=9 alreadyEmbedded=2
//
// with no truncated read and no duplicate ids. The pre-spend
// confirmation ran AFTER the markets upsert, which writes `title` — so
// a row whose venue title had changed was compared against the title
// just written, read as "already embedded", and kept the vector of its
// OLD title for good.
//
// Driven here against an in-memory store that behaves like PostgREST's
// merge-duplicates upsert: a row written without `embedding_v` keeps
// the vector it had.
import { storeThenEmbed, confirmBeforeSpend, scopeResolution } from "../lib/discoverWrites.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

function store(initial) {
  const rows = new Map(initial.map(r => [r.id, { ...r }]));
  return {
    rows,
    readStoredEmbedded: async ids => ({
      data: ids.map(id => rows.get(id)).filter(r => r && r.embedding_v != null)
        .map(r => ({ id: r.id, title: r.title })),
      error: null,
    }),
    upsert: async batch => {
      for (const r of batch) rows.set(r.id, { ...(rows.get(r.id) || {}), ...r });
      return { count: batch.length, errors: [] };
    },
  };
}
const vectorOf = title => `vec(${title})`;

// What the run would do with a store, in the order under test.
async function run(db, fetched, { order = "fixed" } = {}) {
  // needsEmbedding, exactly as lib/discover.js builds it: from a read
  // taken BEFORE anything is written.
  const embeddedTitles = new Map([...db.rows.values()]
    .filter(r => r.embedding_v != null).map(r => [r.id, r.title]));
  const toEmbed = fetched.filter(m => embeddedTitles.get(m.id) !== m.title);
  const embedAndWrite = async confirmed =>
    db.upsert(confirmed.map(m => ({ ...m, embedding_v: vectorOf(m.title) })));

  if (order === "fixed") {
    return storeThenEmbed({
      rows: fetched, toEmbed, readStoredEmbedded: db.readStoredEmbedded,
      writeMarkets: db.upsert, embedAndWrite,
    });
  }
  // CONTROL: the order that shipped — write first, then confirm. The
  // test's fake has to reproduce the live failure with it, or the
  // passing case above proves nothing about the fake.
  await db.upsert(fetched);
  const check = await confirmBeforeSpend(toEmbed, db.readStoredEmbedded);
  if (check.confirmed.length) await embedAndWrite(check.confirmed);
  return { check };
}

const live = () => [
  // Embedded under a title the venue has since changed.
  { id: "KXSENATEMI-26-R", title: "Will Republicans win Michigan? — Mike Rogers (R)", embedding_v: vectorOf("Will Republicans win Michigan? — Mike Rogers") },
  // Embedded and unchanged.
  { id: "KXGDP-26OCT30-T3.0", title: "GDP above 3.0%", embedding_v: vectorOf("GDP above 3.0%") },
];
const fetched = [
  { id: "KXSENATEMI-26-R", title: "Will Republicans win Michigan? — Mike Rogers (R)" },
  { id: "KXGDP-26OCT30-T3.0", title: "GDP above 3.0%" },
  // Never stored.
  { id: "9001", title: "New market" },
];
// The changed row, as the old code saw it: stored title OLD, vector OLD.
const stale = () => {
  const s = live();
  s[0] = { ...s[0], title: "Will Republicans win Michigan? — Mike Rogers" };
  return s;
};

console.log("control: confirming AFTER the write reproduces the live alarm");
{
  const db = store(stale());
  const { check } = await run(db, fetched, { order: "old" });
  ok(check.alreadyEmbedded === 1, `alreadyEmbedded=1 on a clean read (got ${check.alreadyEmbedded})`);
  const row = db.rows.get("KXSENATEMI-26-R");
  ok(row.embedding_v === vectorOf("Will Republicans win Michigan? — Mike Rogers"),
     "and the renamed row keeps the vector of its OLD title");
}

console.log("\nconfirming BEFORE the write: the two reads agree");
{
  const db = store(stale());
  const { check, marketsWrite, embedWrite } = await run(db, fetched);
  ok(check.alreadyEmbedded === 0, `alreadyEmbedded=0 (got ${check.alreadyEmbedded})`);
  ok(check.confirmed.length === 2, `the renamed row and the new one are embedded (got ${check.confirmed.length})`);
  ok(marketsWrite.count === 3 && embedWrite.count === 2, "every row stored, two vectors bought");
  const row = db.rows.get("KXSENATEMI-26-R");
  ok(row.embedding_v === vectorOf(row.title), "the renamed row's vector is built from the title it now carries");

  // And it converges: the next run has nothing to buy.
  const again = await run(db, fetched);
  ok(again.check.confirmed.length === 0 && again.check.alreadyEmbedded === 0,
     "a second run asks for nothing and flags nothing");
}

console.log("\nthe alarm still fires on what it exists for: a stale read");
{
  // needsEmbedding working off a truncated set — simulated by handing
  // the confirmation a row that IS embedded under this exact title.
  const db = store(live());
  const check = await confirmBeforeSpend([fetched[1], fetched[2]], db.readStoredEmbedded);
  ok(check.alreadyEmbedded === 1, "an already-embedded row is declined");
  ok(check.alreadyEmbeddedIds[0] === "KXGDP-26OCT30-T3.0", "and NAMED, not only counted");
  ok(check.confirmed.length === 1 && check.confirmed[0].id === "9001", "the genuinely new row is still bought");
}

console.log("\na failed confirmation falls through and spends");
{
  const check = await confirmBeforeSpend(fetched, async () => ({ error: { message: "57014 statement timeout" } }));
  ok(check.confirmed.length === 3 && check.alreadyEmbedded === 0, "an error is not 'already embedded'");
  ok(check.errors.length === 1 && /57014/.test(check.errors[0]), "and the error is reported");
  const threw = await confirmBeforeSpend(fetched, async () => { throw new Error("fetch failed"); });
  ok(threw.confirmed.length === 3 && threw.errors.length === 1, "a thrown read is the same");
}

console.log("\nforce skips the confirmation; order is confirm, write, embed");
{
  const calls = [];
  await storeThenEmbed({
    rows: fetched, toEmbed: fetched, force: true,
    readStoredEmbedded: async () => { calls.push("read"); return { data: [] }; },
    writeMarkets: async () => { calls.push("write"); return { count: 3 }; },
    embedAndWrite: async c => { calls.push(`embed:${c.length}`); return { count: c.length }; },
  });
  ok(calls.join(",") === "write,embed:3", `force: no read, everything embedded (${calls.join(",")})`);
  calls.length = 0;
  await storeThenEmbed({
    rows: fetched, toEmbed: [fetched[2]],
    readStoredEmbedded: async () => { calls.push("read"); return { data: [] }; },
    writeMarkets: async () => { calls.push("write"); return { count: 3 }; },
    embedAndWrite: async c => { calls.push(`embed:${c.length}`); return { count: c.length }; },
    mark: n => calls.push(`mark:${n}`),
  });
  ok(calls.join(",") === "read,mark:confirm,write,mark:marketsUpsert,embed:1,mark:embed",
     `read BEFORE write (${calls.join(",")})`);
}

// ── resolution text ──────────────────────────────────────────────
console.log("\nresolution text is written only where get_pairs can show it");
{
  const rows = [
    { id: "KXPAIRED-1", sport_tag: "politics", resolution: "rules A" },
    { id: "123", sport_tag: "politics", resolution: "rules B" },          // paired Polymarket side
    { id: "KXLONER-1", sport_tag: "politics", resolution: "rules C" },   // unpaired
    { id: "KXMLBGAME-26SEP301910MILNYM-NYM", sport_tag: "mlb", resolution: "game rules" },
    { id: "456", sport_tag: "econ", resolution: null },
  ];
  const pairedIds = new Set(["KXPAIRED-1", "123"]);
  const sportsTags = new Set(["mlb", "nfl"]);
  const r = scopeResolution(rows, { pairedIds, sportsTags });
  ok(r.rows[0].resolution === "rules A" && r.rows[1].resolution === "rules B", "both sides of a pair keep it");
  ok(r.rows[2].resolution === null, "an unpaired market is written as null");
  ok(r.rows[3].resolution === "game rules", "sports keep it — the same job pairs them minutes later");
  ok(r.kept === 3 && r.nulled === 1 && !r.fallback, `counted: kept=${r.kept} nulled=${r.nulled}`);
  ok(rows[2].resolution === "rules C", "the caller's rows are not mutated");
  ok(Object.keys(r.rows[2]).includes("resolution"),
     "nulled explicitly, not dropped — alignKeys would null it anyway, and explicit is what prune expects");

  const f = scopeResolution(rows, { pairedIds: new Set(), sportsTags, pairsReadFailed: true });
  ok(f.fallback && f.rows === rows && f.rows[2].resolution === "rules C",
     "a failed pairs read writes EVERY row's text rather than stripping live cards");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
