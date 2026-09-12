// Pull the SETTLED outcomes of Kalshi's daily temperature markets.
//
// WHY THIS HAD TO EXIST, AND WHY ITS ABSENCE WAS INVISIBLE.
//
// scripts/wx-record.mjs polls `status=open` only, because its job is
// the perishable half: the book and the forecast, which exist nowhere
// once the window closes. But an open market reports `result: ""`, so
// every row it writes carries a null result — and the recorder never
// revisits a market after settlement.
//
// The consequence is that wx_markets.result would have stayed null
// FOREVER. Every downstream weather question — is NWS good enough to
// trade on, is Kalshi mispriced against the forecast, what are the base
// rates — needs the outcome, so all of them were permanently
// unanswerable while every counter in the recorder read healthy.
//
// It surfaced as `settled weather markets, last 7d 0` on two
// consecutive days, which reads as "not yet" rather than "never". That
// is the same shape as the Set that collapsed 79 frozen series into one
// null: a diagnostic whose zero means two very different things.
//
// The 15-minute family has had backfill-15m.yml since day one for
// exactly this reason. Weather did not, and the gap was between two
// files that each looked complete.

import { WEATHER_CATEGORY, CLI_TO_STATION, kalshiGet, cliFromRules, toWxMarketRow } from "../lib/weather.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const MAX_PAGES = Number(process.env.WX_MAX_PAGES || 8);
const CHUNK = 500;

if (!SUPABASE_URL || !KEY) { console.error("::error::SUPABASE_URL and a key are required"); process.exit(1); }
// Anon cannot write through the RLS policy in 0021, so a run that
// "succeeded" with zero rows is otherwise indistinguishable from a run
// with nothing to write.
console.log(`credential: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon (writes will be REJECTED by RLS)"}`);

async function upsert(rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/wx_markets?on_conflict=ticker`, {
      method: "POST",
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) { console.error(`::error::wx_markets upsert ${r.status}: ${(await r.text()).slice(0, 300)}`); return { written, failed: true }; }
    written += chunk.length;
  }
  return { written, failed: false };
}

// Discovered, not hardcoded — the same rule the recorder uses, so the
// two cannot drift on which series count as daily temperature markets.
const all = (await kalshiGet("/series")).series || [];
const series = all
  .filter(s => s.category === WEATHER_CATEGORY)
  .filter(s => /HIGH|LOW/.test(String(s.ticker || "").toUpperCase()))
  .map(s => s.ticker);
console.log(`daily temperature series: ${series.length}`);

let totalRows = 0, settledRows = 0, failed = false;
const notYetListed = [], skippedNoStation = new Set(), truncated = [];

for (const s of series) {
  const rows = [];
  let cursor = "", pages = 0, cli = null;
  while (pages < MAX_PAGES) {
    pages++;
    const q = `/markets?status=settled&limit=1000&series_ticker=${encodeURIComponent(s)}` +
              (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    let body;
    try { body = await kalshiGet(q); }
    catch (err) { console.log(`::warning::${s} page ${pages}: ${err.message}`); break; }
    const got = body.markets || [];
    if (!got.length) break;
    // The settlement station is stated in the RULES, read once per
    // series. A market whose rules name no CLI station is not a daily
    // station-settled market — same gate as the recorder, so the two
    // tables agree on what belongs.
    if (cli === null) cli = cliFromRules(got[0].rules_primary) || false;
    if (cli === false) { skippedNoStation.add(s); break; }
    if (!CLI_TO_STATION[cli]) console.log(`::warning::unmapped station ${cli} (${s}) — add it to CLI_TO_STATION`);
    for (const m of got) rows.push(toWxMarketRow(m, { series: s, cli }));
    cursor = body.cursor || "";
    if (!cursor) break;
  }
  if (cursor && pages >= MAX_PAGES) truncated.push(s);
  if (!rows.length) { notYetListed.push(s); continue; }

  const withResult = rows.filter(r => r.result === "yes" || r.result === "no").length;
  const res = await upsert(rows);
  if (res.failed) failed = true;
  totalRows += res.written; settledRows += withResult;
}

console.log(`\nseries with settled history  ${series.length - notYetListed.length - skippedNoStation.size}`);
console.log(`rows upserted                ${totalRows}`);
console.log(`...carrying a yes/no result  ${settledRows}`);
if (skippedNoStation.size) console.log(`skipped (no settlement station in rules): ${[...skippedNoStation].join(", ")}`);
// Kalshi registers a series before it ever trades, so zero markets in
// every status is a real state and not a broken fetch.
if (notYetListed.length) console.log(`not yet listed (${notYetListed.length}): ${notYetListed.slice(0, 12).join(", ")}`);
// A page cap reached is a TRUNCATION, not a smaller answer.
if (truncated.length) console.error(`::error::hit the page cap on: ${truncated.join(", ")} — history is INCOMPLETE`);

if (failed) { console.error("::error::at least one upsert failed"); process.exit(1); }
if (!settledRows) {
  console.error("::error::not one settled market carried a result — the outcome half is still empty");
  process.exit(1);
}
