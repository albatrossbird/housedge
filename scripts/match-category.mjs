#!/usr/bin/env node
//
// Match one category's stored markets and write the pairs.
//
// Runs on a GitHub runner rather than in a Vercel function because
// politics does not fit inside the 300s ceiling any more — see the note
// at the top of lib/matcher.js. The matching itself is the SAME code
// the /api/embed route runs; only where it runs has changed.
//
//   node scripts/match-category.mjs politics [--dry] [--threshold=0.86]
//
// Needs SUPABASE_URL and SUPABASE_KEY in the environment.

import { matchNonSportsMarkets } from "../lib/matcher.js";

const [, , category, ...flags] = process.argv;
const dry = flags.includes("--dry");
const thresholdArg = flags.find(f => f.startsWith("--threshold="));

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
  if (!r.ok) throw new Error(`GET ${path.slice(0, 60)} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Paged, and a failed page THROWS rather than returning what it has.
// A read that fails must not look like an empty table: that mistake
// once made a category read as zero stored markets while the live site
// was serving pairs built from those very rows.
async function readAll(select, extra) {
  const out = [];
  let size = 500;
  for (let from = 0; from < 200000; ) {
    const path = `markets?select=${select}&${extra}&offset=${from}&limit=${size}`;
    let rows;
    try {
      rows = await rest(path);
    } catch (err) {
      if (size > 100) { size = Math.floor(size / 2); continue; } // payload too big
      throw err;
    }
    out.push(...rows);
    if (rows.length < size) break;
    from += rows.length;
  }
  return out;
}

const t0 = Date.now();
console.log(`category=${category} threshold=${threshold}${dry ? " (dry)" : ""}`);

const sel = "id,title,sport_tag,embedding";
const kalshi = await readAll(sel, `platform=eq.kalshi&sport_tag=eq.${category}&embedding=not.is.null`);
const poly = await readAll(sel, `platform=in.(${POLY_PLATFORMS.join(",")})&sport_tag=eq.${category}&embedding=not.is.null`);
console.log(`read kalshi=${kalshi.length} poly=${poly.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (!kalshi.length || !poly.length) {
  console.error("::error::one side read as empty — refusing to clear pairs on a partial read");
  process.exit(1);
}

const t1 = Date.now();
const { newPairs, matchDiagnostics } = matchNonSportsMarkets(kalshi, poly, threshold);
console.log(`matched ${newPairs.length} pairs in ${((Date.now() - t1) / 1000).toFixed(0)}s`);

for (const p of (matchDiagnostics.acceptedPairs || []).slice(0, 40)) {
  console.log(`  ${p.score.toFixed(3)} | ${p.kalshi.slice(0, 58)} || ${p.poly.slice(0, 50)}`);
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
