// The weather recorder's parsing, pinned.
//
// Two of these are bugs this repo has already paid for once, in the
// 15-minute recorder, and they are the same bugs in a new place.
//
// Run: node scripts/weather.test.mjs

import { targetDateOf, cliFromRules, toWxMarketRow, toWxQuote, quoteChanged, CLI_TO_STATION } from "../lib/weather.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nthe target DATE is not the close date");
{
  // A market for Sep 10 closes at 05:00Z on Sep 11. Reading the date
  // off close_time is wrong by one day on EVERY market, and silently:
  // it would compare each ladder against the wrong day's forecast and
  // make the whole dataset look mispriced.
  check("reads the date from the ticker", targetDateOf("KXHIGHMIA-26SEP10-B90.5") === "2026-09-10");
  check("handles the open-ended top rung", targetDateOf("KXHIGHMIA-26SEP10-T93") === "2026-09-10");
  check("January", targetDateOf("KXHIGHTDC-27JAN02-B31.5") === "2027-01-02");
  check("unparseable is null, not today", targetDateOf("NOTATICKER") === null);
  check("null in, null out", targetDateOf(null) === null);
}

console.log("\nthe settlement station comes from the RULES");
{
  // KXHIGHMIA and KXHIGHTMIN follow no single convention, so the
  // series ticker cannot be trusted to name the station. The rules
  // state it, and the rules are what settles the contract.
  check("CLIMIA", cliFromRules("maximum temperature recorded at Miami (CLIMIA) for Sep 9") === "CLIMIA");
  check("CLIDFW", cliFromRules("Dallas (CLIDFW) according to The Weather Company") === "CLIDFW");
  check("absent is null", cliFromRules("no station named here") === null);
  check("every mapped CLI has a station", Object.values(CLI_TO_STATION).every(v => /^K[A-Z]{3}$/.test(v)));
}

console.log("\nthe bucket comes from Kalshi's own fields, not the subtitle");
{
  const r = toWxMarketRow(
    { ticker: "KXHIGHMIA-26SEP10-T93", strike_type: "greater", floor_strike: 93,
      cap_strike: null, yes_sub_title: "94° or above", volume_fp: "1000" },
    { series: "KXHIGHMIA", cli: "CLIMIA" });
  check("floor_strike is kept", r.floor_strike === 93);
  // "94° or above" is a RENDERING of floor 93; parsing the string
  // would put the boundary a degree out on every open-ended rung.
  check("an open-ended cap stays null", r.cap_strike === null);
  check("strike_type is kept", r.strike_type === "greater");
  check("station is resolved", r.station === "KMIA");
}

console.log("\nAN EMPTY RESULT IS NOT A SETTLED ONE");
{
  // Kalshi sends result: "" on a live market. Stored as-is, every open
  // market looks settled with a blank outcome — the exact trap m15 hit.
  const live = toWxMarketRow({ ticker: "t", result: "" }, { series: "s", cli: null });
  check('result "" becomes null', live.result === null);
  check("result 'yes' survives", toWxMarketRow({ ticker: "t", result: "yes" }, { series: "s" }).result === "yes");
  check("result 'no' survives", toWxMarketRow({ ticker: "t", result: "no" }, { series: "s" }).result === "no");
}

console.log("\nABSENT DEPTH IS NULL, NEVER ZERO");
{
  // Number(null) is 0, and a fabricated zero reads as "nothing
  // offered" — a claim about the book rather than about our data.
  const q = toWxQuote({ ticker: "t", yes_bid_dollars: "0.48", yes_bid_size_fp: null, yes_ask_size_fp: "" });
  check("a real price is kept", q.yes_bid === 0.48);
  check("null size stays null", q.bid_size === null);
  check('empty-string size stays null', q.ask_size === null);
  check("a missing close_time yields null hours", q.hours_to_close === null);
}

console.log("\nwrite-on-change, with a heartbeat");
{
  const base = { observed_at: "2026-09-09T12:00:00.000Z", yes_bid: 0.48, yes_ask: 0.49, bid_size: 10, ask_size: 10 };
  check("first quote always writes", quoteChanged(null, base) === true);
  check("an identical quote does not", quoteChanged(base, { ...base, observed_at: "2026-09-09T12:05:00.000Z" }) === false);
  check("a moved bid does", quoteChanged(base, { ...base, observed_at: "2026-09-09T12:05:00.000Z", yes_bid: 0.47 }) === true);
  check("a moved SIZE does", quoteChanged(base, { ...base, observed_at: "2026-09-09T12:05:00.000Z", bid_size: 4 }) === true);
  // Without the heartbeat a flat market is indistinguishable from a
  // stopped recorder.
  check("the heartbeat fires at 15 min", quoteChanged(base, { ...base, observed_at: "2026-09-09T12:15:00.000Z" }) === true);
}

console.log("\na monthly market must not read as a daily one");
{
  // KXSJCLOWT asks whether San Jose drops below 40F at ANY HOUR in all
  // of December. Its ticker carries a date like a daily market's, so
  // targetDateOf answers — and the answer is a trap. The rules name no
  // CLI station, and that absence is what the recorder skips on.
  const monthly = "If any hourly temperature value reported for KSJC in San Jose within " +
                  "December 1, 2026 through December 31, 2026 is strictly less than 40 degrees " +
                  "Fahrenheit, then the market resolves to Yes.";
  check("targetDateOf still answers, which is why the rules gate is needed",
        targetDateOf("KXSJCLOWT-26DEC31-40") === "2026-12-31");
  check("a monthly market names no CLI station", cliFromRules(monthly) === null);
  const daily = "If the maximum temperature recorded at Newark (CLIEWR) for Sep 10, 2026, is " +
                "greater than 92\u00b0 fahrenheit according to The Weather Company, then the market resolves to Yes.";
  check("a daily market does", cliFromRules(daily) === "CLIEWR");
}

console.log("\nevery CLI a live series settles on is mapped");
{
  // Read off /series + /markets on 2026-09-10 and each ICAO confirmed
  // against NWS /stations/<icao>. Kalshi settles Chicago at MIDWAY and
  // Houston at HOBBY, which are not the airports either city suggests.
  const live = ["CLIATL","CLIAUS","CLIBOS","CLIDCA","CLIDEN","CLIDFW","CLIEWR","CLIHOU",
                "CLILAS","CLILAX","CLIMDW","CLIMIA","CLIMSP","CLIMSY","CLINYC","CLIOKC",
                "CLIPHL","CLIPHX","CLISAN","CLISAT","CLISDF","CLISEA","CLISFO","CLITTN"];
  for (const cli of live) check(`${cli} is mapped`, typeof CLI_TO_STATION[cli] === "string");
  check("Chicago settles at Midway, not O'Hare", CLI_TO_STATION.CLIMDW === "KMDW");
  check("Houston settles at Hobby, not Intercontinental", CLI_TO_STATION.CLIHOU === "KHOU");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
