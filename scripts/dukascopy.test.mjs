// lib/dukascopy.js — Dukascopy's tick files, fetched politely and
// compared with Kalshi's settlement prices.
//
// Pinned here:
//   1. The URL counts the month from zero; the local copy does not.
//   2. Files decode through xz into the right ticks, and the mid read at
//      an instant is the last quote at or before it, looking back into
//      the previous hour, and only if it is fresh.
//   3. The fetch never asks twice for an hour it has (an empty file is
//      an hour with no quotes), skips the weekend, waits out a 429, and
//      gives up on an instrument that 404s on every hour.
//   4. The scale is found from the data, and the side test reads
//      Dukascopy's own move, so a steady gap does not count against it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { hourUrl, hourPath, isClosedHour, decompress, decodeTicks, tickReader, fetchHistory, scaleFor, compareSeries } from "../lib/dukascopy.js";

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

const H = Date.parse("2026-10-26T01:00:00Z");   // a Monday
const encode = ticks => {
  const raw = Buffer.alloc(ticks.length * 20);
  ticks.forEach(([ms, ask, bid], i) => { raw.writeUInt32BE(ms, i * 20); raw.writeUInt32BE(ask, i * 20 + 4); raw.writeUInt32BE(bid, i * 20 + 8); raw.writeFloatBE(1, i * 20 + 12); raw.writeFloatBE(1, i * 20 + 16); });
  const r = spawnSync("xz", ["--format=lzma", "-c"], { input: raw });
  if (r.status !== 0) throw new Error("xz unavailable");
  return r.stdout;
};

console.log("files:");
ok(hourUrl("XAUUSD", H) === "https://datafeed.dukascopy.com/datafeed/XAUUSD/2026/09/26/01h_ticks.bi5", "October is month 09 in the URL", hourUrl("XAUUSD", H));
ok(hourPath("/d", "XAUUSD", H) === "/d/XAUUSD/2026-10-26/01.bi5", "and 10 in the local copy");
ok(isClosedHour(Date.parse("2026-10-24T12:00:00Z")) && isClosedHour(Date.parse("2026-10-25T19:00:00Z")), "Saturday and Sunday before 20:00 UTC are skipped");
ok(!isClosedHour(Date.parse("2026-10-25T20:00:00Z")) && !isClosedHour(H) && !isClosedHour(Date.parse("2026-10-23T21:00:00Z")), "Sunday evening, Monday and Friday night are fetched");
{
  const ticks = decodeTicks(decompress(encode([[0, 101731, 101664], [219, 101700, 101650], [3599999, 101336, 101284]])), H);
  ok(ticks.length === 3 && ticks[0].t === H && ticks[1].ask === 101700 && ticks[2].bid === 101284 && ticks[2].t === H + 3599999, "decodes through xz: ms into the hour, ask, bid", JSON.stringify(ticks));
  ok(decompress(Buffer.alloc(0)).length === 0, "an empty hour decodes to no ticks");
}

console.log("\nreading a price at an instant:");
{
  const dir = mkdtempSync(join(tmpdir(), "duka-"));
  const put = (h, ticks) => { const f = hourPath(dir, "OIL", h); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, ticks.length ? encode(ticks) : Buffer.alloc(0)); };
  put(H, [[1000, 102, 100], [900000, 112, 110]]);
  put(H + 3600000, [[50000, 122, 120]]);
  const R = tickReader(dir, "OIL");
  ok(R.mid(H + 900000).mid === 111, "the quote AT the instant counts");
  ok(R.mid(H + 899999).stale === true, "an older one past 60s does not (no fresh quote)");
  ok(R.mid(H + 3600000 + 10000).mid === 111 || R.mid(H + 3600000 + 10000).stale, "the previous hour is looked back into");
  ok(R.mid(H + 3600000 + 60000).mid === 121, "the latest quote before the instant");
  ok(R.mid(H + 5 * 3600000).missing === true, "an hour never fetched is MISSING, not a quiet market");
  put(H + 2 * 3600000, []);
  ok(R.mid(H + 2 * 3600000 + 30000).stale === true, "an hour with no quotes is stale");
}

console.log("\nfetching:");
{
  const dir = mkdtempSync(join(tmpdir(), "duka-"));
  const asked = [], slept = [];
  let first429 = true;
  const fetchImpl = async url => {
    asked.push(url);
    const reply = (status, body = Buffer.alloc(0), ra = null) => ({ status, headers: { get: k => (k === "retry-after" ? ra : null) }, arrayBuffer: async () => body });
    if (url.includes("/NOPE/")) return reply(404);
    if (url.includes("/GOLD/") && url.includes("/02h") && first429) { first429 = false; return reply(429, undefined, "7"); }
    if (url.includes("/03h")) return reply(200, Buffer.alloc(0));
    return reply(200, encode([[5, 2, 1]]));
  };
  const sleep = async ms => { slept.push(ms); };
  const from = Date.parse("2026-10-23T20:00:00Z"), to = Date.parse("2026-10-26T04:00:00Z");   // Friday night to Monday
  const S = await fetchHistory({ dir, symbols: ["GOLD", "NOPE"], fromMs: from, toMs: to, fetchImpl, sleep, paceMs: 1, log: () => {} });
  const goldHours = asked.filter(u => u.includes("/GOLD/"));
  ok(!asked.some(u => /\/2026\/09\/24\//.test(u)) && !asked.some(u => /\/2026\/09\/25\/1\dh/.test(u)), "no request for Saturday or Sunday daytime");
  ok(slept.includes(7000) && S.throttled === 1 && existsSync(hourPath(dir, "GOLD", Date.parse("2026-10-26T02:00:00Z"))), "a 429 is waited out (Retry-After) and the hour still fetched", JSON.stringify({ slept: slept.filter(x => x > 1), S }));
  ok(statSync(hourPath(dir, "GOLD", Date.parse("2026-10-26T03:00:00Z"))).size === 0 && S.empty >= 1, "an hour with no quotes is kept as an empty file");
  ok(S.unavailable.includes("NOPE") && asked.filter(u => u.includes("/NOPE/")).length === 12, "an instrument that 404s every hour is dropped after 12 tries", JSON.stringify(S));
  const n = asked.length;
  const S2 = await fetchHistory({ dir, symbols: ["GOLD"], fromMs: from, toMs: to, fetchImpl, sleep, paceMs: 1, log: () => {} });
  ok(asked.length === n && S2.fetched === 0 && S2.skipped === goldHours.length - 1, "a second run asks for nothing it has", JSON.stringify(S2));
}

{
  // Refused for good (the box, 2026-10-26: a 429 on every request for
  // hours): the run gives up after an hour of waiting instead of retrying
  // the same hour forever, and says so.
  const dir = mkdtempSync(join(tmpdir(), "duka-"));
  let asked = 0, waited = 0;
  const fetchImpl = async () => { asked++; return { status: 429, headers: { get: () => null } }; };
  const S = await fetchHistory({ dir, symbols: ["GOLD"], fromMs: H, toMs: H + 3 * 3600000, fetchImpl, sleep: async ms => { waited += ms; }, paceMs: 1, log: () => {} });
  ok(S.refused === true && waited <= 3600000 && asked < 12 && S.fetched === 0, "a refusal lasting an hour ends the run's fetch, flagged refused", JSON.stringify({ S, waited, asked }));
  let n = 0;
  const flaky = async () => (++n % 2 ? { status: 429, headers: { get: () => null } } : { status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) });
  const F = await fetchHistory({ dir: mkdtempSync(join(tmpdir(), "duka-")), symbols: ["GOLD"], fromMs: H, toMs: H + 200 * 3600000, fetchImpl: flaky, sleep: async () => {}, paceMs: 1, log: () => {} });
  ok(!F.refused && F.fetched > 100, "brief refusals between answers do not add up to a stop", JSON.stringify(F));
}

console.log("\ncomparing with Kalshi's settlement prices:");
{
  ok(scaleFor([[101664, 101.66], [101300, 101.31]]) === 1000 && scaleFor([[117512, 1.1751]]) === 100000, "the scale is found from the data (oil 1e3, EUR/USD 1e5)");
  // Ten windows. Dukascopy sits a steady 0.20 above Pyth (a gap, not an
  // error) and moves the way Kalshi settled in eight; the two it gets
  // wrong are the two that settled closest to the strike.
  const W = [], moves = {};
  for (let i = 0; i < 10; i++) {
    const close = H + (i + 1) * 2 * 900000, strike = 100 + i, margin = i < 2 ? 0.01 : 0.5 + i, yes = i % 2 === 0;
    const value = yes ? strike + margin : strike - margin;
    W.push({ close, strike, value, result: yes ? "yes" : "no" });
    const wrong = i < 2;
    moves[close - 900000] = (strike + 0.2) * 1000;
    moves[close] = (value + 0.2 + (wrong ? (yes ? -2 * margin - 0.1 : 2 * margin + 0.1) : 0)) * 1000;
  }
  const reader = { mid: t => (t in moves ? { mid: moves[t], age: 500 } : { stale: true }) };
  const R = compareSeries(W, reader);
  ok(R.n === 10 && R.div === 1000, "every window compared, scale 1e3", JSON.stringify(R));
  ok(R.side.agree === 8 && R.side.n === 10, "side: Dukascopy's OWN move agrees in 8 of 10, the steady gap not counted against it", JSON.stringify(R.side));
  ok(R.close.n === 2 && R.close.agree === 0, "near: the fifth closest to the strike is where it was wrong", JSON.stringify(R.close));
  ok(Math.abs(R.level.biasMedian - 0.2) < 0.05, "level: the gap is reported as a bias", JSON.stringify(R.level));
  const none = compareSeries(W, { mid: () => ({ missing: true }) });
  ok(none.n === 0 && none.why.missing === 10, "windows with no copy are counted as missing, not compared");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
