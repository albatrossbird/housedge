import { pageAll } from "./restPage.js";
import { authHeaders } from "./supabaseHeaders.js";

// Retention for `markets`.
//
// The table has never been pruned. It holds every fixture and every
// market either venue has listed since the project started, and this
// stopped being a tidiness question: selects carrying `embedding` are
// ~20KB a row, and once crypto and politics passed ~4,000 Polymarket
// rows those reads began failing outright, which surfaced as a category
// reporting zero stored markets. The 500MB free tier is the ceiling.
//
// Two rules, both conservative, because deleting a market that is still
// tradable is worse than keeping a dead one:
//
//   1. Never touch a row referenced by `pairs`. Those are what the site
//      renders, and get_pairs joins straight through them.
//   2. Only delete rows the venues have stopped listing. Discovery
//      refreshes `updated_at` on everything it fetches, so a row that
//      has not been touched in `days` is one neither venue returned on
//      any run since — not merely one nobody looked at.
//
// Past-dated sports fixtures are pruned on the same "not seen" rule
// rather than on their game date: Kalshi keeps a game listed while it
// settles, and deleting it mid-settlement would drop a row `pairs` may
// still point at.

// Two weeks past a market's last sighting. Chosen from the data, not
// picked round: at 21 days nothing qualified, at 14 exactly 872 rows did
// — the finished MLB fixtures neither venue lists any more. A shorter
// window risks deleting a market during a quiet spell in discovery; a
// longer one never bites on a table that churns daily.
const DEFAULT_DAYS = 14;
const CHUNK = 200;

// ── Reads: lib/restPage.js, and NO ROW CAP ─────────────────────────
//
// This file had its own keyset pager with `maxRows = 200000`, and it
// returned what it had when it got there — silently. On 2026-09-26 and
// 09-28 the job printed
//
//   pruned 9059 of 200000 markets
//
// Exactly 200,000 is not a table size, it is the cap. `markets` was
// already ~190,000 rows when migration 0022 was written, so the read
// stopped at the 200,000th id and every row past it in id order was
// NEVER A PRUNE CANDIDATE: delisted markets in the tail of the key
// space could not be deleted however long ago they were last seen.
// A pruner that cannot see part of the table lets exactly that part
// grow without bound, and a bigger `markets` is what every statement
// timeout in this job is made of.
//
// The shared pager has no cap and fails loudly instead of degrading:
// a key missing from the select, or a cursor that cannot advance,
// throws. A read that throws here refuses the prune, which is the
// correct answer to "I could not see the table".
//
// Plain REST rather than supabase-js, so the job needs no client and
// scripts/prune.test.mjs can drive it against a fake PostgREST.
function defaultRest() {
  const base = `${process.env.SUPABASE_URL}/rest/v1/`;
  const key = process.env.SUPABASE_ANON_KEY;
  return {
    async get(path) {
      const r = await fetch(base + path, { headers: authHeaders(key) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json();
    },
    // DELETE / PATCH with count=exact; the count arrives in
    // Content-Range as `*/<n>`.
    async write(method, path, body) {
      try {
        const r = await fetch(base + path, {
          method,
          headers: authHeaders(key, {
            "Content-Type": "application/json",
            Prefer: "return=minimal,count=exact",
          }),
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!r.ok) return { error: `${r.status} ${(await r.text()).slice(0, 200)}` };
        const m = /\/(\d+)$/.exec(r.headers.get("content-range") || "");
        return { count: m ? Number(m[1]) : null };
      } catch (err) {
        return { error: `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}` };
      }
    },
  };
}

// Quoted, so an id carrying a comma or a parenthesis cannot split the
// list. .in() puts its values in the query string, which is why every
// caller chunks.
const inList = ids => `(${ids.map(id => encodeURIComponent(`"${String(id).replace(/"/g, '\\"')}"`)).join(",")})`;

// One chunked write that SPLITS on a statement timeout rather than
// losing the chunk. Measured 2026-09-28: three 200-row `resolution`
// updates hit 57014 in one run. Halving is the same answer upsertRows
// gives the markets write — a statement that timed out because of its
// size will time out again at the same size — and it bottoms out at a
// single row, which either writes or is named.
async function writeChunk(rest, method, ids, body, errors) {
  // An empty in-list is never sent: a DELETE whose filter went missing
  // is the one write here that cannot be taken back.
  if (!ids.length) return 0;
  const { error, count } = await rest.write(method, `markets?id=in.${inList(ids)}`, body);
  if (!error) return count ?? ids.length;
  if (ids.length > 1 && /57014|statement timeout|timed? ?out|^50[234]\b/i.test(error)) {
    const mid = Math.ceil(ids.length / 2);
    return (await writeChunk(rest, method, ids.slice(0, mid), body, errors)) +
           (await writeChunk(rest, method, ids.slice(mid), body, errors));
  }
  errors.push(`${ids.length === 1 ? ids[0] : `${ids.length} row(s)`}: ${error}`);
  return 0;
}

// Retention, separated from the route for the same reason as
// lib/refreshPrices.js and lib/discover.js: the scheduled run happens
// in the Actions runner, and a serverless function is not needed to
// read Supabase and delete rows. The route stays hittable by hand.
//
// Returns { status, body }; the route maps it to HTTP.
//
// `deps.rest` replaces the network, for scripts/prune.test.mjs.
export async function runPrune(params = {}, deps = {}) {
  const q = params;
  const rest = deps.rest || defaultRest();
  const read = async (table, select, filter) => {
    try { return { rows: await pageAll(rest.get, table, select, filter), errors: [] }; }
    catch (err) { return { rows: [], errors: [err.message] }; }
  };
  const __r = (status, body) => ({ status, body });

  const days = Math.max(parseInt(q.days || DEFAULT_DAYS, 10) || DEFAULT_DAYS, 7);
  const dry = q.dry === "1";
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    // Everything the site renders. Read first and in full — a partial
    // read here would put live rows in the delete set.
    // `id` is selected only so the keyset pager has something to seek
    // on; the protection set is built from the other two columns.
    const pairsRead = await read("pairs", "id,kalshi_id,polymarket_id", "");
    if (pairsRead.errors.length) {
      return __r(500, { error: "could not read pairs; refusing to prune", details: pairsRead.errors });
    }
    const protectedIds = new Set();
    for (const p of pairsRead.rows) {
      protectedIds.add(String(p.kalshi_id));
      protectedIds.add(String(p.polymarket_id));
    }

    // Deliberately does not select `embedding` — this is the read that
    // was failing on payload size, and it needs none of it.
    const marketsRead = await read("markets", "id,platform,sport_tag,updated_at,slug", "");
    if (marketsRead.errors.length) {
      return __r(500, { error: "could not read markets; refusing to prune", details: marketsRead.errors });
    }

    const byCategory = {};
    const doomed = [];
    for (const m of marketsRead.rows) {
      const cat = m.sport_tag || "untagged";
      byCategory[cat] = byCategory[cat] || { total: 0, prunable: 0, paired: 0 };
      byCategory[cat].total++;

      if (protectedIds.has(String(m.id))) { byCategory[cat].paired++; continue; }

      const seen = Number(m.updated_at) || 0;
      if (seen >= cutoff) continue;

      byCategory[cat].prunable++;
      doomed.push(m.id);
    }

    let deleted = 0;
    const errors = [];
    if (!dry) {
      // Chunked: .in() puts its values in the query string, and a few
      // thousand ids build a URL long enough to kill the request —
      // which is how pair clearing silently did nothing for weeks.
      for (let i = 0; i < doomed.length; i += CHUNK) {
        deleted += await writeChunk(rest, "DELETE", doomed.slice(i, i + CHUNK), null, errors);
      }
    }

    // ── Resolution text on rows nothing can display ────────────────
    //
    // `resolution` holds Kalshi's rules_primary, and it is stored for
    // every market in the catalogue but readable on almost none of
    // them: the only path to it is get_pairs, which JOINS pairs, so a
    // row outside `pairs` has text nobody can reach. 55,355 rows carry
    // it where roughly 2,000 can show it.
    //
    // Measured 2026-09-01: markets TOAST was 581MB, of which the JSON
    // embedding accounted for 266MB and the vector for 147MB, leaving
    // ~168MB unexplained — this column.
    //
    // Nulling rather than deleting the row, because the market itself
    // is still wanted: it is fetched, stored, and searchable by title.
    // Discovery rewrites the text on the next run for anything that
    // becomes paired, so this is self-healing rather than lossy — the
    // panel already says "hasn't been fetched yet" for a row without it.
    //
    // Runs AFTER the delete so it never updates a row that just went.
    //
    // NOTE: nulling a TOASTed value marks space reusable, it does not
    // return it to the OS. The database's reported size will not fall
    // until a rewrite; what this stops is the GROWTH.
    let resolutionCleared = 0;
    const resolutionErrors = [];
    //
    // The read is a keyset walk over `resolution IS NOT NULL`, which is
    // SPARSE now that discovery stops writing the text onto unpaired
    // rows — a few thousand of ~200,000. Walking the primary key to
    // find them is most of the table per page; migration 0030 adds the
    // partial index that makes it a seek. Until it is run, a timeout
    // here is a warning and costs only this cleanup.
    const resRead = await read("markets", "id", "resolution=not.is.null");
    if (resRead.errors.length) {
      resolutionErrors.push(...resRead.errors);
    } else {
      const unreadable = resRead.rows
        .map(r => String(r.id))
        .filter(id => !protectedIds.has(id));
      if (dry) {
        resolutionCleared = unreadable.length;
      } else {
        // A plain PATCH, not upsert. An upsert with a partial column
        // set fails NOT NULL `platform` on the attempted insert row even
        // when the row already exists.
        for (let i = 0; i < unreadable.length; i += CHUNK) {
          resolutionCleared += await writeChunk(
            rest, "PATCH", unreadable.slice(i, i + CHUNK), { resolution: null }, resolutionErrors);
        }
      }
    }

    return __r(200, {
      dry,
      days,
      cutoffIso: new Date(cutoff * 1000).toISOString(),
      marketsScanned: marketsRead.rows.length,
      pairsProtecting: protectedIds.size,
      candidates: doomed.length,
      deleted: dry ? 0 : deleted,
      byCategory,
      resolutionRowsCarrying: resRead.errors.length ? null : resRead.rows.length,
      resolutionCleared,
      resolutionErrors: resolutionErrors.slice(0, 3),
      errors: errors.slice(0, 5),
    });
  } catch (err) {
    return __r(500, { error: err.message });
  }
}
