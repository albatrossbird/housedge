// The order of the discovery run's writes, and what each one carries.
//
// Kept apart from lib/discover.js because that file creates a Supabase
// client at import time, and these rules have to be testable with no
// database and no node_modules — scripts/discover-writes.test.mjs
// drives them against an in-memory store.

// ── CONFIRM BEFORE THE WRITE, NOT AFTER IT ─────────────────────────
//
// The pre-spend confirmation re-asks the database about exactly the
// rows about to be paid for, and a disagreement with `needsEmbedding`
// is an alarm that fails the run. It ran AFTER the markets upsert —
// and that upsert writes `title`. So for any row whose venue title had
// changed since its vector was built, the sequence was:
//
//   needsEmbedding   stored "old" vs fetched "new"   -> needs a vector
//   markets upsert   stored title becomes "new"      (vector untouched)
//   confirmation     stored "new" vs fetched "new"   -> "already embedded"
//
// The second opinion was comparing the fetched title against ITSELF.
// Measured: politics failed on `alreadyEmbedded=2` every day for at
// least five days (runs 45-49, 2026-09-24..28) on a read that reported
// no truncation and a fetch with no duplicate ids — the signature of
// this, not of a stale read. And it was worse than a noisy alarm: the
// declined rows were never re-embedded, their stored title now matched,
// so the next run saw nothing to do and the vector built from the OLD
// title stayed on the row for good — matched on text the market no
// longer says.
//
// Before the write, both reads see the same state, so they can only
// disagree when one of them is wrong — which is the one thing the
// alarm exists to say. storeThenEmbed owns the order so it cannot be
// re-shuffled back by an edit to the long function around it.
export async function confirmBeforeSpend(toEmbed, readStoredEmbedded, { chunk = 200 } = {}) {
  const errors = [];
  const stored = new Map();
  for (let i = 0; i < toEmbed.length; i += chunk) {
    const ids = toEmbed.slice(i, i + chunk).map(m => m.id);
    let res;
    try { res = await readStoredEmbedded(ids); } catch (e) { res = { error: e }; }
    // A FAILED CHECK MUST NOT SUPPRESS THE WORK. Treating an error as
    // "already embedded" would silently stop embedding whenever
    // Supabase hiccuped, which is a worse failure than paying twice.
    if (res?.error) {
      errors.push(res.error.message || JSON.stringify(res.error));
      continue;
    }
    for (const r of res?.data || []) stored.set(String(r.id), r.title);
  }
  const confirmed = [];
  const declined = [];
  for (const m of toEmbed) (stored.get(String(m.id)) === m.title ? declined : confirmed).push(m);
  return {
    confirmed,
    alreadyEmbedded: declined.length,
    // NAMED, not only counted. "2 rows" every day for five days could
    // not say whether it was the same two rows or two new ones, which
    // is the question that decides between a flip-flopping title and a
    // stale read.
    alreadyEmbeddedIds: declined.slice(0, 10).map(m => String(m.id)),
    errors,
  };
}

// confirm -> write markets -> embed, in that order.
//
//   rows                everything fetched, written without a vector
//   toEmbed             what needsEmbedding and the gate chose
//   readStoredEmbedded  ids -> { data: [{id, title}], error } for rows
//                       that CARRY a vector
//   writeMarkets        rows -> write result
//   embedAndWrite       confirmed rows -> write result (vector + row)
export async function storeThenEmbed({
  rows, toEmbed, force = false,
  readStoredEmbedded, writeMarkets, embedAndWrite,
  mark = () => {},
}) {
  let check = { confirmed: toEmbed, alreadyEmbedded: 0, alreadyEmbeddedIds: [], errors: [] };
  // `force` re-embeds everything, which is what it is for.
  if (toEmbed.length > 0 && !force) check = await confirmBeforeSpend(toEmbed, readStoredEmbedded);
  mark("confirm");

  const marketsWrite = await writeMarkets(rows);
  mark("marketsUpsert");

  const embedWrite = check.confirmed.length > 0 ? await embedAndWrite(check.confirmed) : null;
  mark("embed");

  return { check, marketsWrite, embedWrite };
}

// ── resolution text goes only where something can read it ─────────
//
// `resolution` (Kalshi's rules_primary, Polymarket's description) is
// readable only through get_pairs, which JOINS `pairs` — so on an
// unpaired row it is text nobody can reach. /api/prune nulls it there.
// And discovery wrote it back onto EVERY fetched row, every day:
//
//   prune resolution: cleared 61339 unreadable of 64799 carrying  (09-28)
//                     cleared 69084 unreadable of 72214 carrying  (09-26)
//
// ~65,000 rows of multi-KB text rewritten by the upsert and then
// updated back to null by prune, daily — two jobs undoing each other.
// It is payload on the slowest write in the run (politics'
// marketsUpsert took 282s on 09-28) and three of prune's 200-row
// clearing updates hit the statement timeout the same day.
//
// So the upsert writes the text for rows that are PAIRED, and for
// SPORTS rows, which the same job pairs minutes later by an exact join
// — withholding it there would leave every new fixture's card without
// its rules until tomorrow. Everything else is written as NULL, which
// is the state prune would have put it in anyway; a non-sports market
// that pairs later (match-markets.yml) gets its text on the next
// discovery run, exactly as it did when prune cleared it first.
//
// IF THE PAIRS READ FAILED, WRITE EVERYTHING. Nulling on a partial
// protection set would strip the text off cards the site is showing —
// the same reason prune refuses to run on a failed pairs read.
export function scopeResolution(rows, { pairedIds, sportsTags, pairsReadFailed = false }) {
  if (pairsReadFailed) return { rows, kept: null, nulled: 0, fallback: true };
  let kept = 0;
  let nulled = 0;
  const out = rows.map(r => {
    if (r == null || r.resolution == null) return r;
    if (sportsTags.has(r.sport_tag) || pairedIds.has(String(r.id))) { kept++; return r; }
    nulled++;
    return { ...r, resolution: null };
  });
  return { rows: out, kept, nulled, fallback: false };
}
