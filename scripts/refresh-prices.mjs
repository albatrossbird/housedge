// The scheduled price refresh, run in the GitHub Actions runner.
//
// It used to be a curl at https://housedge.vercel.app/api/refresh. That
// made every scheduled sweep a Vercel function invocation — ~8-12 a day
// at ~90 seconds each — and measured 2026-09-07 it was the dominant
// consumer of the Hobby plan's 4 Fluid Active CPU-hours a MONTH, at 3
// of 4 used, spent almost entirely on cron traffic hitting our own API
// with essentially no visitors on the site.
//
// The job reads two public venues and writes Supabase. None of that
// needs a serverless function, and Actions minutes are free and
// unmetered on a public repo.
//
// THE ROUTE IS UNCHANGED and still serves the browser's on-demand
// refresh, which is what actually keeps prices ~3 minutes fresh. Both
// callers run the same runRefresh() out of lib/refreshPrices.js, so the
// scheduled sweep and the on-demand one cannot drift — the same reason
// lib/matcher.js is shared between the route and match-category.mjs.
import { runRefresh } from "../lib/refreshPrices.js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("::error::SUPABASE_URL / SUPABASE_ANON_KEY repository secrets are not set");
  process.exit(1);
}

// ifStale=0: the scheduled run always reads the venues. The cooldown
// exists to bound what the BROWSER can ask for, and the runner is the
// credentialed caller the route would have let through anyway.
const r = await runRefresh({ ifStale: 0 });

console.log(JSON.stringify(r, null, 1).slice(0, 2000));

const n = (v) => Number(v) || 0;
const K = n(r.kalshiUpdated), P = n(r.polyUpdated);
const KF = n(r.kalshiFetched), PF = n(r.polyFetched);
console.log(`\nkalshi updated: ${K}/${KF} fetched, polymarket updated: ${P}/${PF} fetched, us: ${n(r.polyUsUpdated)}/${n(r.polyUsRequested)}`);

let failed = false;
const fail = (msg) => { console.error(`::error::${msg}`); failed = true; };

for (const e of (r.errors || []).slice(0, 3)) fail(e);

// PER VENUE, not combined. This check was `K === 0 && P === 0`, so
// polyUpdated sat at 0 while kalshiUpdated carried the run — every
// global Polymarket price on the site frozen, with a green tick on
// every run saying so.
if (K === 0 && KF > 0) fail(`fetched ${KF} Kalshi markets and wrote none`);
if (P === 0 && PF > 0) fail(`fetched ${PF} Polymarket markets and wrote none`);
if (K === 0 && P === 0) fail("refresh updated 0 rows on both venues");

// A throttled Kalshi series returns no markets and used to be
// indistinguishable from a series with none open, so its rows just
// stopped updating. Named, so the next occurrence is loud.
for (const s of (r.kalshiSeriesFailed || [])) fail(`kalshi series failed: ${s}`);

// THE ALARM THIS JOB WAS REWRITTEN AROUND. A series a paired ticker
// points at that the job never polls means those prices freeze forever
// with nothing to say so. Must stay empty.
for (const s of (r.kalshiSeriesUnpolled || [])) fail(`kalshi series never polled: ${s}`);
for (const id of (r.kalshiUnderivableIds || []).slice(0, 10)) {
  fail(`paired ticker yields no series, so it can never refresh: ${id}`);
}

for (const w of (r.warnings || [])) console.log(`::warning::${w}`);
for (const s of (r.polyShortfall || [])) console.log(`::warning::polymarket shortfall: ${s}`);
for (const e of (r.polyFetchErrors || []).slice(0, 3)) console.log(`::warning::polymarket: ${e}`);
for (const e of (r.polyUsErrors || []).slice(0, 3)) console.log(`::warning::polymarket US: ${e}`);

process.exit(failed ? 1 : 0);
