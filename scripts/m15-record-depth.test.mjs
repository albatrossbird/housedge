// The 15-minute recorder, driven end to end against a fake Kalshi and a
// fake PostgREST, to pin what depth recording must never do.
//
// WHY THE WHOLE SCRIPT AND NOT A HELPER. This is the recorder whose data
// cannot be backfilled, and every rule below is about how three things
// interact inside one run — the /markets read, the /orderbook read, and
// a database that may not have the columns yet. A helper test cannot see
// an interaction. The weather recorder's version of this caught a real
// bug before it shipped: an unscoped strip that would have failed every
// forecast write.
//
// The rules:
//   1. Touch size comes from `yes_bid_size_fp`, the key Kalshi sends.
//   2. Depth rides on quotes already being written.
//   3. A failed book read costs the DEPTH, never the quote.
//   4. A database without migration 0027 costs the depth columns, never
//      the quote, and says which migration to run.
//   5. Stripping one optional group never strips another.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

const harness = (o) => `
import { writeFileSync } from "node:fs";
const O = ${JSON.stringify(o)};
const posted = [];
const close = new Date(Date.now() + 600000).toISOString();

const json = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body),
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("api.elections.kalshi.com")) {
    if (u.includes("/series?")) {
      return json({ series: u.includes("category=Crypto") ? [{ ticker: "KXBTC15M", title: "BTC 15m" }] : [] });
    }
    if (u.includes("/orderbook")) {
      if (O.bookFails) return json({ error: "not found" }, 404);
      return json({ orderbook_fp: {
        yes_dollars: [["0.3700","1644.60"],["0.3800","4981.98"]],
        no_dollars:  [["0.6000","1094.00"],["0.6100","291.65"]],
      }});
    }
    return json({ markets: [{
      ticker: "KXBTC15M-TEST-30", event_ticker: "KXBTC15M-TEST", title: "BTC up?",
      close_time: close, open_time: new Date().toISOString(),
      yes_bid_dollars: "0.3800", yes_ask_dollars: "0.3900",
      yes_bid_size_fp: "4981.98", yes_ask_size_fp: "291.65",
      volume_fp: "1000.00", floor_strike: 80000, result: "",
    }] });
  }
  if (init.method === "POST") {
    const table = u.split("/rest/v1/")[1].split("?")[0];
    const rows = JSON.parse(init.body);
    posted.push({ table, rows });
    if (table === "m15_quotes") {
      if (O.noDepthCols && rows.some(r => "book_bid" in r))
        return json({ code: "PGRST204", message: "Could not find the 'book_bid' column of 'm15_quotes' in the schema cache" }, 400);
      if (O.noSourceCol && rows.some(r => "source" in r))
        return json({ code: "42703", message: 'column "source" of relation "m15_quotes" does not exist' }, 400);
    }
    return json({}, 201);
  }
  return json([]);   // the credential probe
};

let out = "";
const log = console.log; console.log = (...a) => { out += a.join(" ") + "\\n"; };
process.on("exit", () => writeFileSync(O.out, JSON.stringify({ posted, out })));

process.env.SUPABASE_URL = "https://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
process.env.M15_RUN_MINUTES = "0.002";
process.env.M15_POLL_SECONDS = "0";
process.env.INVOCATION_ID = "test";
delete process.env.M15_SOURCE; delete process.env.GITHUB_ACTIONS;

await import(${JSON.stringify(join(HERE, "m15-record.mjs"))});
`;

function run(o) {
  const dir = mkdtempSync(join(tmpdir(), "m15rec-"));
  const out = join(dir, "r.json"), file = join(dir, "h.mjs");
  writeFileSync(file, harness({ ...o, out }));
  try { execFileSync(process.execPath, [file], { stdio: "pipe" }); } catch {}
  return JSON.parse(readFileSync(out, "utf8"));
}
// Only rows the fake database ACCEPTED count as written.
const accepted = (r, o) => {
  const ok = [];
  for (const p of r.posted.filter(p => p.table === "m15_quotes")) {
    const rej = (o.noDepthCols && p.rows.some(x => "book_bid" in x)) || (o.noSourceCol && p.rows.some(x => "source" in x));
    if (!rej) ok.push(...p.rows);
  }
  return ok;
};

let failed = 0;
const check = (c, w) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}`); } };

console.log("everything available");
{
  const o = {}; const r = run(o); const q = accepted(r, o);
  check(q.length > 0, "quotes are written");
  const x = q[0] || {};
  check(x.bid_size === 4981.98, "touch size from yes_bid_size_fp");
  check(x.book_bid === 0.38 && x.book_ask === 0.39, "book touch recorded, ask mirrored from the NO stack");
  check(x.bid_depth_1c === 6626.58, "bid depth within 1c");
  check(x.ask_depth_1c === 1385.65, "ask depth within 1c");
  check(x.source === "box", "source still stamped");
  check(/books=\d+ bookErrors=0/.test(r.out), "the run reports book reads and zero failures");
}

console.log("\nthe book read fails");
{
  const o = { bookFails: true }; const r = run(o); const q = accepted(r, o);
  check(q.length > 0, "the QUOTE is still written — price path is never traded for depth");
  const x = q[0] || {};
  check(x.yes_bid === 0.38, "with its price");
  check(x.bid_size === 4981.98, "and its touch size, which came from /markets, not the book");
  check(x.bid_depth_1c === null && x.book_bid === null, "depth is NULL (not fetched), never a coerced 0");
  check("bid_depth_1c" in x, "and the key is present, so a mixed batch stays key-uniform (PGRST102)");
  check(/bookErrors=[1-9]/.test(r.out), "and the failure is counted");
}

console.log("\nmigration 0027 not yet run");
{
  const o = { noDepthCols: true }; const r = run(o); const q = accepted(r, o);
  check(q.length > 0, "quotes are still written");
  check(!("book_bid" in (q[0] || {})), "without the depth columns");
  check((q[0] || {}).source === "box", "but source is NOT stripped with them");
  check((q[0] || {}).bid_size === 4981.98, "and touch size, an existing column, survives");
  check(/0027_m15_quotes_depth\.sql/.test(r.out), "the warning names the migration to run");
}

console.log("\nneither migration run, and Postgres's own error shape");
{
  const o = { noDepthCols: true, noSourceCol: true }; const r = run(o); const q = accepted(r, o);
  check(q.length > 0, "quotes are still written");
  check(!("book_bid" in (q[0] || {})) && !("source" in (q[0] || {})), "with both groups stripped");
  check(/0023_m15_quotes_source\.sql/.test(r.out) && /0027_m15_quotes_depth\.sql/.test(r.out),
        "and both migrations named — the 42703 \\\"column\\\" form is recognised, not just PGRST204's");
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log("\nall passed");
