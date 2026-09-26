// The weather recorder's write path, driven end to end against a fake
// Kalshi, a fake NWS and a fake PostgREST.
//
// WHAT THIS PINS, AND WHY IT IS NOT OBVIOUS. wx_quotes gained a
// `source` column naming which recorder wrote the row, and the recorder
// drops that column and keeps going if the migration has not been run —
// a deploy can land first, and an unattributed row is a worse reading
// where an unrecorded one is a hole.
//
// wx_forecasts ALREADY HAS A `source` COLUMN AND IT MEANS SOMETHING
// ELSE: the forecast provider, 'nws', and it is NOT NULL. A first
// version of the degrade was unscoped, so wx_quotes missing its column
// would have stripped the provider off every forecast row and failed
// all of them on a null violation — the recorder reacting to a missing
// column by breaking a table that was fine. Nothing in the loop would
// have said so beyond a warning among others.
//
// The whole script is driven rather than a helper called, because the
// bug lives in which table a flag applies to, and that is only real
// once both tables are written in one run.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

// The harness runs in its own process because wx-record.mjs is a
// top-level script that calls process.exit.
const harness = (opts) => `
import { writeFileSync } from "node:fs";
const REJECT_QUOTE_SOURCE = ${opts.rejectQuoteSource};
const posted = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (body, status = 200) => ({
    ok: status < 400, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  if (u.includes("api.elections.kalshi.com")) {
    if (u.includes("/series?") || u.endsWith("/series"))
      return json({ series: [{ ticker: "KXHIGHMIA", category: "Climate and Weather" }] });
    return json({ markets: [{
      ticker: "KXHIGHMIA-26SEP24-B90",
      event_ticker: "KXHIGHMIA-26SEP24",
      title: "Miami high temperature", rules_primary: "settles according to the Miami climate product (CLIMIA)",
      strike_type: "between", floor_strike: 89, cap_strike: 90,
      close_time: new Date(Date.now() + 86400000).toISOString(),
      yes_bid_dollars: "0.4000", yes_ask_dollars: "0.4300",
      yes_bid_size_fp: "10", yes_ask_size_fp: "12", volume_fp: "500",
    }] });
  }

  if (u.includes("api.weather.gov")) {
    if (u.includes("/stations/"))
      return json({ geometry: { coordinates: [-80.29, 25.79] },
                    properties: { forecast: "https://api.weather.gov/gridpoints/MFL/110,50/forecast" } });
    if (u.includes("/points/"))
      return json({ properties: { forecast: "https://api.weather.gov/gridpoints/MFL/110,50/forecast" } });
    return json({ properties: { periods: [
      { number: 1, name: "Today", isDaytime: true, temperature: 90, temperatureUnit: "F",
        startTime: new Date().toISOString(), shortForecast: "Sunny" },
      { number: 2, name: "Tonight", isDaytime: false, temperature: 75, temperatureUnit: "F",
        startTime: new Date().toISOString(), shortForecast: "Clear" },
    ] } });
  }

  // PostgREST.
  if (init.method === "POST") {
    const table = u.split("/rest/v1/")[1].split("?")[0];
    const rows = JSON.parse(init.body);
    posted.push({ table, rows });
    if (REJECT_QUOTE_SOURCE && table === "wx_quotes" && rows.some(r => "source" in r))
      return json({ code: "PGRST204", message: "Could not find the 'source' column of 'wx_quotes'" }, 400);
    return json({}, 201);
  }
  return json([]);   // the credential probe
};

process.on("exit", () => writeFileSync(${JSON.stringify(opts.out)}, JSON.stringify(posted)));

process.env.SUPABASE_URL = "https://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fake";
process.env.WX_RUN_MINUTES = "0.001";
process.env.WX_POLL_MINUTES = "0";
process.env.WX_FORECAST_MINUTES = "0";
process.env.INVOCATION_ID = "test-invocation";
delete process.env.GITHUB_ACTIONS;

await import(${JSON.stringify(join(HERE, "wx-record.mjs"))});
`;

function run(opts) {
  const dir = mkdtempSync(join(tmpdir(), "wxrec-"));
  const out = join(dir, "posted.json");
  const file = join(dir, "harness.mjs");
  writeFileSync(file, harness({ ...opts, out }));
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { stdout = (e.stdout || "") + (e.stderr || ""); }
  return { posted: JSON.parse(execFileSync("cat", [out], { encoding: "utf8" })), stdout };
}

let failed = 0;
const check = (cond, what) => { if (!cond) { console.error(`FAIL ${what}`); failed++; } else console.log(`  ok  ${what}`); };
const rowsFor = (posted, table) => posted.filter(p => p.table === table).flatMap(p => p.rows);

console.log("the column is there");
{
  const { posted, stdout } = run({ rejectQuoteSource: false });
  const quotes = rowsFor(posted, "wx_quotes");
  const forecasts = rowsFor(posted, "wx_forecasts");
  check(quotes.length > 0, "quotes are written");
  check(quotes.every(q => q.source === "box"), "every quote is stamped 'box' from INVOCATION_ID");
  check(forecasts.length > 0, "forecasts are written");
  check(forecasts.every(f => f.source === "nws"), "forecast source stays the PROVIDER, not the recorder");
  check(rowsFor(posted, "wx_markets").every(m => !("source" in m)),
        "wx_markets is upserted on ticker and carries no source at all");
  check(/source: box/.test(stdout), "the run says which recorder it is");
}

console.log("\nthe column is NOT there — the migration has not been run yet");
{
  const { posted, stdout } = run({ rejectQuoteSource: true });
  const quotes = rowsFor(posted, "wx_quotes");
  const forecasts = rowsFor(posted, "wx_forecasts");
  check(quotes.some(q => "source" in q), "the first attempt carries source");
  check(quotes.some(q => !("source" in q)), "and the retry drops it rather than losing the hour");
  check(forecasts.length > 0, "forecasts still written");
  // THE BUG. An unscoped degrade strips this too, and it is NOT NULL.
  check(forecasts.every(f => f.source === "nws"),
        "the wx_quotes degrade does NOT strip wx_forecasts.source");
  check(/0026_wx_quotes_source\.sql/.test(stdout),
        "the warning names the migration, not just the missing column");
}

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log("\nall passed");
