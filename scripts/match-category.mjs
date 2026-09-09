#!/usr/bin/env node
//
// Match one category's stored markets and write the pairs.
//
// Runs on a GitHub runner rather than in a Vercel function because
// politics does not fit inside the 300s ceiling any more — see the note
// at the top of lib/matcher.js. The matching itself is the SAME code
// the /api/embed route runs; only where it runs has changed.
//
//   node scripts/match-category.mjs politics [--dry] [--threshold=0.86] [--out=dir]
//
// --out writes EVERY accepted pair as a TSV. The log prints the top 40
// and matchDiagnostics.acceptedPairs is capped at 100, neither of which
// is an audit of a run that accepted 1,196 pairs. A wrong pair renders a
// fake arbitrage, so the whole list has to be readable before it is
// published.
//
// Needs SUPABASE_URL and SUPABASE_KEY in the environment.

import fs from "node:fs";
import path from "node:path";

import { matchNonSportsMarkets } from "../lib/matcher.js";

const [, , category, ...flags] = process.argv;
const dry = flags.includes("--dry");
const thresholdArg = flags.find(f => f.startsWith("--threshold="));
const outArg = flags.find(f => f.startsWith("--out="));

const THRESHOLDS = { politics: 0.86, crypto: 0.88, econ: 0.81 };
const threshold = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : (THRESHOLDS[category] ?? 0.81);

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
if (!category) { console.error("usage: match-category.mjs <category> [--dry]"); process.exit(2); }
if (!URL || !KEY) { console.error("SUPABASE_URL and SUPABASE_KEY are required"); process.exit(2); }

const POLY_PLATFORMS = ["polymarket", "polymarket_us"];

async function rest(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    // 57014 on this query means the predicate has no index, not that
    // the page is too big — the pager's halving retry shrank the page
    // to 62 rows and still timed out, because the LAST page has to walk
    // the rest of the table to prove there are no more matches. Name
    // the migration rather than leaving the next reader to rediscover
    // it from a bare Postgres code.
    const hint = body.includes("57014")
      ? " — run supabase/migrations/0018_markets_category_index.sql"
      : "";
    throw new Error(`GET ${path.slice(0, 60)} -> ${r.status} ${body}${hint}`);
  }
  return r.json();
}

// Paged, and a failed page THROWS rather than returning what it has.
// A read that fails must not look like an empty table: that mistake
// once made a category read as zero stored markets while the live site
// was serving pairs built from those very rows.
//
// KEYSET, AND ORDERED — it was NEITHER, and both halves were bugs. This
// was the last OFFSET pager on a live path, and it broke on 2026-09-08:
//
//   GET markets?select=id,title,platform,sport_tag,embedding_v
//       -> 500 {"code":"57014","message":"canceling statement due to
//                statement timeout"}
//
// so POLITICS COULD NOT MATCH AT ALL. `offset=N` makes Postgres scan
// and discard every row before the window, so paging a category costs
// O(n^2) and the LAST pages are the slowest — which is why this worked
// for months and then stopped: `markets` went from 63,000 rows to
// 133,000 when the polymarket.us page cap was lifted, and the final
// offsets stopped fitting inside the statement timeout. Keyset paging
// reads each page from an index seek, so page 60 costs what page 1
// costs.
//
// It also had NO `order` at all. Postgres promises nothing about row
// order without one and may return a different order for the same
// query, so consecutive pages could overlap or SKIP rows outright — a
// skipped Kalshi row is a market that silently cannot pair, and a
// skipped Polymarket row is a candidate nothing can match against.
//
// The halving retry is kept but demoted: it is for payload-size
// failures, and it could never have fixed this one — the cost was the
// offset scan, not the bytes.
async function readAll(select, extra) {
  const out = [];
  // 150, NOT 500, AND THE REASON IS MEASURED.
  //
  // EXPLAIN (analyze, buffers) on the same predicate WITHOUT
  // `embedding_v`:
  //
  //   Index Scan using markets_category_keyset
  //   Buffers: shared hit=487        (all cache, zero disk reads)
  //   Execution Time: 0.713 ms
  //
  // Finding the rows costs SEVEN TENTHS OF A MILLISECOND. The same
  // page carrying `embedding_v` took ~2,700ms in the runner, so
  // essentially all of it is the vector: 4KB per row, stored
  // out-of-line, so a 500-row page moves ~2MB. The index was never the
  // problem, and neither was OFFSET paging, and neither was the
  // migration — three wrong theories before this measurement.
  //
  // The timeout bites somewhere around 3-5s (failures observed at 3.1
  // to 5.6s), so a 500-row page sits just under the line and the slow
  // ones tip over. 150 rows is ~600KB and lands near 0.8s, which is
  // headroom rather than a coin flip. The extra round trips are free
  // next to a category that cannot match at all.
  let size = 150;
  let last = null;
  const pageMs = [];
  for (let page = 0; page < 1000; page++) {
    const after = last == null ? "" : `&id=gt.${encodeURIComponent(last)}`;
    const path = `markets?select=${select}&${extra}${after}&order=id.asc&limit=${size}`;
    let rows;
    // PER-PAGE TIMING, because two fixes for this read were shipped on a
    // guess about WHICH page was slow and both were wrong. A read that
    // fails after two minutes tells you nothing on its own: the first
    // page timing out means the predicate has no usable index, while a
    // late page timing out means something about the tail. The log now
    // says which, so the next change is a measurement rather than a
    // third theory.
    const tPage = Date.now();
    try {
      rows = await rest(path);
    } catch (err) {
      console.log(`  page ${page} FAILED after ${((Date.now() - tPage) / 1000).toFixed(1)}s at size=${size}, ${out.length} rows read so far`);
      // Halve down to 25, not 100. The floor was set when the cost was
      // believed to be the scan, where a smaller page cannot help; now
      // that it is known to be bytes, a smaller page is exactly what
      // helps, and stopping at 100 gave up while the fix was still
      // available.
      if (size > 25) { size = Math.floor(size / 2); continue; }
      throw err;
    }
    const ms = Date.now() - tPage;
    pageMs.push(ms);
    // Slow pages are still called out, but a filtered log is a BIASED
    // SAMPLE and reading one as if it were the whole distribution is
    // how "page cost does not scale with page size" got asserted here:
    // only pages over 2s were printed, so the fast small pages that
    // would have disproved it were never shown. The summary below
    // reports every page.
    if (ms > 2000) {
      console.log(`  slow page ${page}: ${rows.length} rows in ${(ms / 1000).toFixed(1)}s (${out.length + rows.length} total)`);
    }
    out.push(...rows);
    if (rows.length < size) {
      const sorted = [...pageMs].sort((a, b) => a - b);
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      console.log(`  read ${out.length} rows in ${pageMs.length} pages — page ms min/median/max ${sorted[0] ?? 0}/${med}/${sorted[sorted.length - 1] ?? 0}`);
      return out;
    }
    last = rows[rows.length - 1].id;
  }
  // Falling out of the loop means the page cap was reached without a
  // short page, which is a TRUNCATION, not an answer — and a short read
  // here silently drops candidates the matcher then reports as
  // unmatched. The halving retry can shrink `size`, so the cap is not a
  // fixed row count and must be checked rather than assumed generous.
  throw new Error(`readAll hit its page cap at ${out.length} rows (page size ${size}) — the read is TRUNCATED`);
}

const t0 = Date.now();
console.log(`category=${category} threshold=${threshold}${dry ? " (dry)" : ""}`);

const sel = "id,title,platform,sport_tag,embedding_v";
const kalshi = await readAll(sel, `platform=eq.kalshi&sport_tag=eq.${category}&embedding_v=not.is.null`);

// ONE READ PER PLATFORM, NOT ONE `IN` LIST — and the reason is in the
// contrast between these two lines, measured on the same run:
//
//   platform=eq.kalshi          14,181 rows, 95 pages, median 510ms
//   platform=in.(poly, poly_us) failed at 3.1s — at 150 rows, at 75,
//                               at 37, and at EIGHTEEN
//
// Eighteen rows is ~72KB and took 3.0 seconds, which rules out payload
// size as the cause on this side. `markets_category_keyset` is
// (sport_tag, platform, id): an equality on `platform` walks one index
// range already ordered by id, which is why the Kalshi read is fast.
// An IN list makes `id` non-leading across TWO ranges, so `order=id`
// can no longer be satisfied by a walk and the rows are SORTED — with
// the 4KB vector carried through the sort, and the sort completed
// before LIMIT can discard anything. That is a cost the page size
// cannot touch, which is exactly the shape observed.
//
// Split into equalities, the poly side gets the same plan the Kalshi
// side already proves fast. Order across the concatenation does not
// matter: the matcher scores every pair and never relies on input
// order.
const poly = [];
for (const platform of POLY_PLATFORMS) {
  const rows = await readAll(sel, `platform=eq.${platform}&sport_tag=eq.${category}&embedding_v=not.is.null`);
  console.log(`  ${platform}: ${rows.length} rows`);
  poly.push(...rows);
}
console.log(`read kalshi=${kalshi.length} poly=${poly.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (!kalshi.length || !poly.length) {
  console.error("::error::one side read as empty — refusing to clear pairs on a partial read");
  process.exit(1);
}

const t1 = Date.now();
const { newPairs, matchDiagnostics } = matchNonSportsMarkets(kalshi, poly, threshold);
console.log(`matched ${newPairs.length} pairs in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// A count alone does not say whether a run is 1,196 good pairs or 30
// good ones and a templated family cross-matching itself. The shape of
// the score distribution does, and it costs nothing to print.
const buckets = new Map();
for (const p of newPairs) {
  const b = (Math.floor(p.similarity * 100) / 100).toFixed(2);
  buckets.set(b, (buckets.get(b) || 0) + 1);
}
console.log("score distribution (accepted):");
for (const b of [...buckets.keys()].sort().reverse()) {
  console.log(`  ${b}  ${"#".repeat(Math.min(60, buckets.get(b)))} ${buckets.get(b)}`);
}

for (const p of (matchDiagnostics.acceptedPairs || []).slice(0, 40)) {
  console.log(`  ${p.score.toFixed(3)} | ${p.kalshi.slice(0, 58)} || ${p.poly.slice(0, 50)}`);
}

if (outArg) {
  const dir = outArg.split("=")[1];
  fs.mkdirSync(dir, { recursive: true });
  const byId = new Map([...kalshi, ...poly].map(m => [m.id, m]));
  const tsv = ["score\tvenue\tkalshi_id\tpoly_id\tkalshi_title\tpoly_title"];
  for (const p of newPairs) {
    const k = byId.get(p.kalshi_id), pm = byId.get(p.polymarket_id);
    const cell = v => String(v ?? "").replace(/[\t\r\n]+/g, " ");
    tsv.push([
      p.similarity.toFixed(4), cell(pm?.platform), p.kalshi_id, p.polymarket_id,
      cell(k?.title), cell(pm?.title),
    ].join("\t"));
  }
  const file = path.join(dir, `pairs-${category}.tsv`);
  fs.writeFileSync(file, tsv.join("\n") + "\n");
  console.log(`wrote ${newPairs.length} rows to ${file}`);
}

if (dry) { console.log("dry run — nothing written"); process.exit(0); }

// Clear immediately before the write, never before the match: a failure
// during matching must leave the previous pairs standing rather than
// emptying a live tab. Same ordering as pages/api/embed.js.
const ids = kalshi.map(m => m.id);
for (let i = 0; i < ids.length; i += 200) {
  const chunk = ids.slice(i, i + 200).map(id => `"${id.replace(/"/g, '\\"')}"`).join(",");
  const r = await fetch(`${URL}/rest/v1/pairs?kalshi_id=in.(${encodeURIComponent(chunk)})`, {
    method: "DELETE",
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) { console.error(`::error::clear failed: ${r.status} ${(await r.text()).slice(0, 200)}`); process.exit(1); }
}

for (let i = 0; i < newPairs.length; i += 500) {
  const r = await fetch(`${URL}/rest/v1/pairs?on_conflict=kalshi_id,polymarket_id`, {
    method: "POST",
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(newPairs.slice(i, i + 500)),
  });
  if (!r.ok) { console.error(`::error::write failed: ${r.status} ${(await r.text()).slice(0, 300)}`); process.exit(1); }
}

console.log(`wrote ${newPairs.length} pairs in ${((Date.now() - t0) / 1000).toFixed(0)}s total`);
