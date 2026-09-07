// The daily discovery run, in the GitHub Actions runner.
//
// It used to be a shell loop curling /api/embed twice per category plus
// /api/prune. Politics alone spends 86-109s of Vercel function time in
// that loop, and measured 2026-09-07 the job was the second largest
// consumer of the Hobby plan's 4 Fluid Active CPU-hours a month, after
// the price refresh. Reading two venues, calling Voyage and writing
// Supabase does not need a serverless function.
//
// Both routes are KEPT and call the same runEmbed()/runPrune(), so a
// hand-hit endpoint and the scheduled job cannot drift.
//
// TWO STAGES PER CATEGORY, unchanged. Politics cannot do fetch + embed
// + match inside one pass without the run growing unbounded, and the
// two halves read different things (the venues, then Supabase), so they
// split cleanly. The fetch stage is re-runnable on its own: embedding
// is capped per call and embedRemaining says what is left.
import { runEmbed } from "../lib/discover.js";
import { runPrune } from "../lib/pruneMarkets.js";

const CATEGORIES = (process.env.CATEGORIES || "mlb nfl ncaaf nba nhl soccer econ crypto politics")
  .trim().split(/\s+/).filter(Boolean);
// Sports match here — an exact join, fast. Non-sports matching runs in
// match-markets.yml, which has no ceiling and its own audit artifact.
const SPORTS_MATCHED_HERE = new Set(["mlb", "nfl", "ncaaf", "nba", "nhl", "soccer"]);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY repository secrets are not set");
  process.exit(1);
}

// Sports categories never embed, so the key is not needed for a
// sports-only run. Where it IS needed, embedTitles throws on Voyage's
// 401 and the per-category catch reports it — but naming the cause here
// beats reading "Voyage AI error 401" and guessing which secret is
// missing from a runner that never needed one before.
const NEEDS_VOYAGE = CATEGORIES.some(c => !SPORTS_MATCHED_HERE.has(c));
if (NEEDS_VOYAGE && !process.env.VOYAGE_API_KEY) {
  console.log("::warning::VOYAGE_API_KEY is not set as a repository secret; embedding will fail for non-sports categories");
}

let failed = false;
const fail = (m) => { console.error(`::error::${m}`); failed = true; };
const warn = (m) => console.log(`::warning::${m}`);
const n = (v) => Number(v) || 0;

for (const cat of CATEGORIES) {
  console.log(`::group::${cat}`);
  try {
    const { status, body: f } = await runEmbed({ fetchonly: "1", sport: cat });
    if (status !== 200 || f.error) {
      fail(`${cat}: fetch stage returned ${status}${f.error ? `: ${f.error}` : ""}`);
      console.log("::endgroup::");
      continue;
    }

    console.log(`${cat} fetch: embedded=${n(f.embedded)} remaining=${n(f.embedRemaining)} marketsUpserted=${n(f.writes?.marketsUpserted)}`);
    const t = f.timingsMs || {};
    if (Object.keys(t).length) {
      console.log(`  timings: ${Object.entries(t).map(([k, v]) => `${k}=${v}ms`).join(" ")}`);
    }
    const sm = f.seriesMeta;
    if (sm?.series != null) console.log(`  seriesMeta: ${sm.series} series (${sm.fromStore} stored, ${sm.fetched} fetched)`);
    const st = sm?.status || {};
    const stLive = Object.entries(st).filter(([, v]) => v > 0);
    if (stLive.length) console.log(`  seriesMeta status: ${stLive.map(([k, v]) => `${k}=${v}`).join(" ")}`);
    const dropped = Object.entries(f.polyDroppedNoKalshiSide || {});
    if (dropped.length) console.log(`  poly dropped (no Kalshi side): ${dropped.map(([k, v]) => `${k}=${v}`).join(" ")}`);

    // THE ONLY THING THIS PROJECT PAYS PER ROW FOR. alreadyEmbedded is
    // the count the pre-spend check caught being bought twice; 0 in
    // steady state. Politics quietly re-bought 1,200 a run for months
    // while reporting them as work done, so this is an error.
    const sp = f.embedSpend;
    if (sp?.asked != null) console.log(`  embed spend: asked=${sp.asked} embedded=${sp.embedded} alreadyEmbedded=${sp.alreadyEmbedded}`);
    if (n(sp?.alreadyEmbedded) > 0) {
      fail(`${cat}: ${sp.alreadyEmbedded} rows were about to be re-embedded — needsEmbedding is reading a stale or truncated set`);
    }
    for (const e of (sp?.confirmErrors || [])) warn(`embed pre-spend check: ${e}`);

    // A read that hit its row cap returned a WRONG answer, not a short
    // one. This is what hid the re-embedding.
    for (const e of (f.truncatedReads || [])) fail(e);
    for (const e of (f.embeddedReadErrors || [])) fail(`embedded-titles read: ${e}`);

    // The category sweep paginates ALL open Kalshi events and keeps the
    // ones in the category — Kalshi has no server-side category filter
    // — so anything ending the pass early drops the tail of the
    // catalogue while every other counter reports success. `complete`
    // is true ONLY on an exhausted cursor.
    for (const s of (f.kalshiSweep || [])) {
      console.log(`  sweep ${s.category}: pages=${s.pages} events=${s.eventsSeen} kept=${s.marketsKept} complete=${s.complete}${s.failure ? ` failure=${s.failure}` : ""}`);
      if (!s.complete) {
        fail(`${s.category}: Kalshi sweep INCOMPLETE after ${s.pages} pages (${s.eventsSeen} events) — ${s.failure || "no reason reported"} — the tail of the catalogue was not fetched`);
      }
    }

    const g = f.embedGate;
    if (g?.enabled) {
      console.log(`  gate: skipped ${g.skipped} in tried-but-unproven series (proven ${g.seriesProven}, tried ${g.seriesTried})`);
      if (g.skippedSeries?.length) console.log(`  gate skipped: ${g.skippedSeries.slice(0, 8).join(" ")}`);
    }
    // Rows a venue handed us twice. Expected and non-zero on econ,
    // whose Polymarket side is five overlapping tags; a WRITE ERROR
    // beside it would mean the dedupe missed a shape.
    if (n(f.writes?.duplicateIdsDropped) > 0) {
      console.log(`  duplicate ids dropped before write: ${f.writes.duplicateIdsDropped}`);
    }
    for (const e of (f.writes?.marketsErrors || []).slice(0, 3)) warn(e);
    for (const e of (f.writes?.embeddingErrors || []).slice(0, 3)) warn(e);
    if (n(f.embedRemaining) > 0) warn(`${cat}: ${f.embedRemaining} titles still need embedding; next run continues`);

    if (!SPORTS_MATCHED_HERE.has(cat)) {
      console.log(`${cat}: fetch done — matching runs in match-markets.yml`);
      console.log("::endgroup::");
      continue;
    }

    const { status: ms, body: m } = await runEmbed({ matchonly: "1", sport: cat });
    if (ms !== 200 || m.error) {
      fail(`${cat}: match stage returned ${ms}${m.error ? `: ${m.error}` : ""}`);
      console.log("::endgroup::");
      continue;
    }
    console.log(`${cat} match: newPairs=${n(m.newPairs)} totalPairs=${n(m.totalPairs)}`);
    const d = m.matchDiagnostics || {};

    // BOTH VENUES LIST THIS LEAGUE AND NOTHING JOINED. A sports join is
    // exact, so this is never a close call: the vocabularies disagree,
    // or a venue changed its identifier format — the failure that hid
    // the MLB title-format change. Guarded on polyKeyed so a league
    // Kalshi lists and Polymarket does not stays quiet.
    if (n(d.kalshiKeyed) > 0 && n(d.polyKeyed) > 0 && n(d.joined) === 0) {
      fail(`${cat}: both venues keyed games and ZERO joined — kalshiKeyed=${d.kalshiKeyed} polyKeyed=${d.polyKeyed}; the team-code vocabularies disagree or an identifier format changed`);
    }
    if (n(d.joinedNextDay) > 0) {
      console.log(`  joined via next-day retry: ${d.joinedNextDay} (Kalshi dates in ET, Polymarket in UTC)`);
    }
    if (n(d.kalshiKeyFailures) > 0) {
      warn(`${cat}: ${d.kalshiKeyFailures} Kalshi markets produced no game key`);
    }
    for (const e of [...(m.writes?.marketsErrors || []), ...(m.writes?.pairsErrors || [])].slice(0, 3)) warn(e);
  } catch (err) {
    fail(`${cat}: threw: ${err.message}`);
  }
  console.log("::endgroup::");
}

// Retention, AFTER the category loop: discovery refreshes updated_at on
// everything the venues still list, so running it first is what makes
// "not seen in N days" mean delisted rather than not fetched yet.
console.log("::group::prune");
try {
  const { status, body: p } = await runPrune({});
  if (status !== 200 || p.error) {
    warn(`prune returned ${status}${p.error ? `: ${p.error}` : ""}`);
  } else {
    console.log(`pruned ${n(p.deleted)} of ${n(p.marketsScanned)} markets, ${n(p.pairsProtecting)} protected`);
    if (p.resolutionCleared != null) {
      console.log(`  resolution: cleared ${p.resolutionCleared} unreadable of ${n(p.resolutionRowsCarrying)} carrying`);
    }
    for (const e of (p.resolutionErrors || []).slice(0, 3)) warn(`prune resolution: ${e}`);
    for (const e of (p.errors || []).slice(0, 3)) warn(`prune: ${e}`);
  }
} catch (err) {
  warn(`prune threw: ${err.message}`);
}
console.log("::endgroup::");

process.exit(failed ? 1 : 0);
