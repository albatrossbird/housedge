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
  let size = 500;
  let last = null;
  for (let page = 0; page < 1000; page++) {
    const after = last == null ? "" : `&id=gt.${encodeURIComponent(last)}`;
    const path = `markets?select=${select}&${extra}${after}&order=id.asc&limit=${size}`;
    let rows;
    try {
      rows = await rest(path);
    } catch (err) {
      if (size > 100) { size = Math.floor(size / 2); continue; } // payload too big
      throw err;
    }
    out.push(...rows);
    if (rows.length < size) return out;
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
const poly = await readAll(sel, `platform=in.(${POLY_PLATFORMS.join(",")})&sport_tag=eq.${category}&embedding_v=not.is.null`);
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
