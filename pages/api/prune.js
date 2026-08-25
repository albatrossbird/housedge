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

const DEFAULT_DAYS = 21;
const CHUNK = 200;

async function pageAll(build, { pageSize = 1000, maxRows = 200000 } = {}) {
  const out = [];
  let size = pageSize;
  let from = 0;
  const errors = [];
  while (from < maxRows) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) {
      if (size > 100) { size = Math.floor(size / 2); continue; }
      errors.push(error.message || JSON.stringify(error));
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    from += size;
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
    const pairsRead = await pageAll(() => supabase.from("pairs").select("kalshi_id, polymarket_id"));
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

    res.status(200).json({
      dry,
      days,
      cutoffIso: new Date(cutoff * 1000).toISOString(),
      marketsScanned: marketsRead.rows.length,
      pairsProtecting: protectedIds.size,
      candidates: doomed.length,
      deleted: dry ? 0 : deleted,
      byCategory,
      errors: errors.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
