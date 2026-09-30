// A paired Kalshi market that has stopped trading must leave the site.
//
// FEDHIKE-26DEC31 closed EARLY on 2026-09-16 — the Fed hiked, the market
// settled YES — and was still on the economics tab on 2026-09-30 quoting
// its last live book at 94/95, 13 days stale, with `profitable: true`.
// The refresh's open-series poll correctly stopped returning it; nothing
// downstream knew why, and /api/markets had no close rule outside sports.
// See lib/kalshiClosed.js.
import { classifyPairedMissed, kalshiCloseHasPassed, lookupKalshiTickers } from "../lib/kalshiClosed.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const NOW = Date.parse("2026-09-30T00:30:00Z");

// Copied from live responses to /markets?tickers=… on 2026-09-30, cut to
// the fields read — not hand-shaped to match the code. The m15 depth
// fixture that was hand-written to agree with a wrong read passed for
// weeks.
const FEDHIKE = {
  ticker: "FEDHIKE-26DEC31", event_ticker: "FEDHIKE", status: "finalized", result: "yes",
  can_close_early: true, close_time: "2026-09-16T19:08:29Z",
  expiration_time: "2027-01-01T15:00:00Z", yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000",
};
const DISSENT_SEP = {
  ticker: "KXFEDDISSENT-26SEP-MICH", event_ticker: "KXFEDDISSENT-26SEP", status: "finalized",
  result: "no", close_time: "2026-09-16T17:59:00Z",
};
const DISSENT_OCT = {
  ticker: "KXFEDDISSENT-26OCT-NEEL", event_ticker: "KXFEDDISSENT-26OCT", status: "active",
  result: "", close_time: "2026-10-28T17:59:00Z",
};

console.log("the three stale econ legs of 2026-09-30 are classified closed");
{
  const r = classifyPairedMissed(
    ["FEDHIKE-26DEC31", "KXFEDDISSENT-26SEP-MICH"], [FEDHIKE, DISSENT_SEP], NOW);
  ok(r.closed.length === 2 && !r.stillOpen.length && !r.notFound.length, "both closed, nothing else");
  const fed = r.closed.find(c => c.id === "FEDHIKE-26DEC31");
  // The EARLY close is the point: the stored close_time said Dec 31, and
  // that is why the card showed 93 days to resolve on a settled market.
  ok(fed.closeTime === "2026-09-16T19:08:29.000Z", `FEDHIKE carries its real, early close (${fed.closeTime})`);
  ok(fed.status === "finalized" && fed.result === "yes", "named with status and result");
}

console.log("\nthe write is close_time ONLY — never a price, never updated_at");
{
  const [c] = classifyPairedMissed(["FEDHIKE-26DEC31"], [FEDHIKE], NOW).closed;
  ok(JSON.stringify(Object.keys(c.write).sort()) === '["close_time","id"]',
    `keys: ${Object.keys(c.write).join(",")}`);
  // Writing Kalshi's settled 0/1 book or a fresh updated_at would make a
  // 13-day-old price read as just observed. The age must stay honest.
  ok(!("updated_at" in c.write) && !("yes_price" in c.write) && !("bid" in c.write), "no price, no timestamp");
}

console.log("\nwhat the refresh writes is what /api/markets hides on");
{
  const [c] = classifyPairedMissed(["FEDHIKE-26DEC31"], [FEDHIKE], NOW).closed;
  ok(kalshiCloseHasPassed(c.write.close_time, NOW), "written close_time reads as passed");
  // And the stored value BEFORE the fix did not — which is the bug.
  ok(!kalshiCloseHasPassed("2027-01-01T04:59:00Z", NOW), "the scheduled Dec 31 close did not");
}

console.log("\na terminal market still carrying a FUTURE close_time is clamped to now");
{
  const odd = { ticker: "X-1", status: "determined", result: "no", close_time: "2027-06-01T00:00:00Z" };
  const [c] = classifyPairedMissed(["X-1"], [odd], NOW).closed;
  ok(c && c.write.close_time === new Date(NOW).toISOString(), `written as now (${c && c.write.close_time})`);
  ok(kalshiCloseHasPassed(c.write.close_time, NOW), "so it is hidden, not left on screen");
}

console.log("\na TRADING market the open poll missed is an alarm, not a closure");
{
  const r = classifyPairedMissed(["KXFEDDISSENT-26OCT-NEEL"], [DISSENT_OCT], NOW);
  ok(!r.closed.length, "not written as closed");
  ok(r.stillOpen.length === 1 && r.stillOpen[0].status === "active", "reported as still open, with status");
}

console.log("\nan active status past its close time is closed — status lags the clock");
{
  const lag = { ...DISSENT_OCT, ticker: "L-1", close_time: "2026-09-29T00:00:00Z" };
  const r = classifyPairedMissed(["L-1"], [lag], NOW);
  ok(r.closed.length === 1 && r.closed[0].closeTime === "2026-09-29T00:00:00.000Z", "closed at its own close_time");
}

console.log("\nan id the lookup did not return is NAMED, not guessed");
{
  const r = classifyPairedMissed(["GONE-1", "FEDHIKE-26DEC31"], [FEDHIKE], NOW);
  ok(r.notFound.length === 1 && r.notFound[0] === "GONE-1", "notFound names it");
  ok(r.closed.length === 1, "and the one Kalshi did return still classifies");
}

console.log("\nkalshiCloseHasPassed: absence is not evidence of closure");
{
  ok(!kalshiCloseHasPassed(null, NOW), "null -> not closed");
  ok(!kalshiCloseHasPassed("", NOW), "empty -> not closed");
  ok(!kalshiCloseHasPassed("not a date", NOW), "garbage -> not closed");
  ok(kalshiCloseHasPassed(NOW - 1, NOW), "epoch ms in the past -> closed");
  ok(!kalshiCloseHasPassed("2026-10-28T17:59:00Z", NOW), "future -> open");
}

// ── The lookup, against a fake Kalshi ──────────────────────────────
const noSleep = async () => {};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

console.log("\nthe lookup chunks at 50 and reads tickers from the query");
{
  const ids = Array.from({ length: 120 }, (_, i) => `S-${i}`);
  const urls = [];
  const fake = async url => {
    urls.push(url);
    const tickers = decodeURIComponent(new URL(url).searchParams.get("tickers")).split(",");
    // Kalshi omits unknown tickers; return all but S-7.
    return res(200, { cursor: "", markets: tickers.filter(t => t !== "S-7").map(t => ({ ticker: t, status: "finalized", close_time: "2026-09-01T00:00:00Z" })) });
  };
  const r = await lookupKalshiTickers(ids, { fetchImpl: fake, sleep: noSleep });
  ok(urls.length === 3, `3 requests for 120 ids (got ${urls.length})`);
  // A default page size would truncate the answer the way Gamma's
  // default limit of 20 did; `limit` must be sent and must cover the chunk.
  ok(urls.every(u => /[?&]limit=(50|20)\b/.test(u)), "limit sent per chunk");
  ok(r.markets.length === 119 && !r.errors.length, `119 back, S-7 omitted (got ${r.markets.length})`);
  const c = classifyPairedMissed(ids, r.markets, NOW);
  ok(c.notFound.join() === "S-7" && c.closed.length === 119, "the omission surfaces by name");
}

console.log("\na 429 is retried; a hard failure is reported and its ids are NOT 'not found'");
{
  let calls = 0;
  const flaky = async () => (++calls === 1 ? res(429, {}) : res(200, { markets: [FEDHIKE] }));
  const r1 = await lookupKalshiTickers(["FEDHIKE-26DEC31"], { fetchImpl: flaky, sleep: noSleep });
  ok(r1.markets.length === 1 && calls === 2, "recovered on the retry");

  let hard = 0;
  const broken = async () => { hard++; return res(400, {}); };
  const r2 = await lookupKalshiTickers(["A-1", "B-2"], { fetchImpl: broken, sleep: noSleep });
  ok(hard === 1, "a 400 is an answer, not retried");
  ok(r2.errors.length === 1 && /HTTP 400/.test(r2.errors[0]), `error named: ${r2.errors[0]}`);
  // Folding a failed request into notFound would be a claim about Kalshi
  // made from our own broken call.
  ok(r2.failedIds.join() === "A-1,B-2", "failed ids returned for the caller to exclude");

  const thrower = async () => { throw new Error("ECONNRESET"); };
  const r3 = await lookupKalshiTickers(["C-3"], { fetchImpl: thrower, sleep: noSleep });
  ok(r3.errors.length === 1 && r3.failedIds.join() === "C-3", "a thrown fetch is reported too");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
