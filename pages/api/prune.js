import { createClient } from "@supabase/supabase-js";
import { cronAuthorized } from "../../lib/cronAuth.js";
import { kalshiGameKey, polyGameKey } from "../../lib/sportsKeys.js";

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Two weeks past a market's last sighting. Chosen from the data, not
// picked round: at 21 days nothing qualified, at 14 exactly 872 rows did
// — the finished MLB fixtures neither venue lists any more. A shorter
// window risks deleting a market during a quiet spell in discovery; a
// longer one never bites on a table that churns daily.
const DEFAULT_DAYS = 14;
const CHUNK = 200;

// KEYSET, NOT OFFSET. `.range(from, from+size)` is LIMIT/OFFSET, and an
// OFFSET makes Postgres scan and discard every row before the window —
// so paging a 63,000-row table costs O(n²) in total and the last pages
// are the slowest. That is why this read worked for months and then
// started returning `canceling statement due to statement timeout`: the
// table grew past what the final offsets could do inside the limit.
//
// Ordering by the key and asking for `key > last` reads each page from
// an index seek instead, so page 60 costs what page 1 costs. Halving on
// error is kept for payload-size failures, which are a different thing
// and were the original reason it exists.
async function pageAll(build, { key = "id", pageSize = 1000, maxRows = 200000 } = {}) {
  const out = [];
  let size = pageSize;
  let last = null;
  const errors = [];
  while (out.length < maxRows) {
    let q = build().order(key, { ascending: true }).limit(size);
    if (last != null) q = q.gt(key, last);
    const { data, error } = await q;
    if (error) {
      if (size > 100) { size = Math.floor(size / 2); continue; }
      errors.push(error.message || JSON.stringify(error));
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    last = data[data.length - 1][key];
    // A key that is not actually on the row would loop forever.
    if (last == null) {
      errors.push(`pageAll: key "${key}" missing from row; cannot page safely`);
      break;
    }
  }
  return { rows: out, errors };
}

export default async function handler(req, res) {
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });

  const days = Math.max(parseInt(req.query.days || DEFAULT_DAYS, 10) || DEFAULT_DAYS, 7);
  const dry = req.query.dry === "1";
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    // Everything the site renders. Read first and in full — a partial
    // read here would put live rows in the delete set.
    // `id` is selected only so the keyset pager has something to seek
    // on; the protection set is built from the other two columns.
    const pairsRead = await pageAll(() => supabase.from("pairs").select("id, kalshi_id, polymarket_id"));
    if (pairsRead.errors.length) {
      return res.status(500).json({ error: "could not read pairs; refusing to prune", details: pairsRead.errors });
    }
    const protectedIds = new Set();
    for (const p of pairsRead.rows) {
      protectedIds.add(String(p.kalshi_id));
      protectedIds.add(String(p.polymarket_id));
    }

    // Deliberately does not select `embedding` — this is the read that
    // was failing on payload size, and it needs none of it.
    const marketsRead = await pageAll(() => supabase
      .from("markets").select("id, platform, sport_tag, updated_at, slug"));
    if (marketsRead.errors.length) {
      return res.status(500).json({ error: "could not read markets; refusing to prune", details: marketsRead.errors });
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
        const chunk = doomed.slice(i, i + CHUNK);
        const { error, count } = await supabase
          .from("markets").delete({ count: "exact" }).in("id", chunk);
        if (error) errors.push(error.message || JSON.stringify(error));
        else deleted += count || chunk.length;
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
    const resRead = await pageAll(() => supabase
      .from("markets").select("id").not("resolution", "is", null));
    if (resRead.errors.length) {
      resolutionErrors.push(...resRead.errors);
    } else {
      const unreadable = resRead.rows
        .map(r => String(r.id))
        .filter(id => !protectedIds.has(id));
      if (dry) {
        resolutionCleared = unreadable.length;
      } else {
        // Plain .update(), not upsert. An upsert with a partial column
        // set fails NOT NULL `platform` on the attempted insert row even
        // when the row already exists.
        for (let i = 0; i < unreadable.length; i += CHUNK) {
          const chunk = unreadable.slice(i, i + CHUNK);
          const { error, count } = await supabase
            .from("markets").update({ resolution: null }, { count: "exact" }).in("id", chunk);
          if (error) resolutionErrors.push(error.message || JSON.stringify(error));
          else resolutionCleared += count || chunk.length;
        }
      }
    }

    res.status(200).json({
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
    res.status(500).json({ error: err.message });
  }
}
