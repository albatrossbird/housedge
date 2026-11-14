// Ladder consistency: which Kalshi crypto markets settle on the same
// number, and which one's Yes implies another's. See lib/ladder.js and
// docs/research/ladder-plan.md.
//
// The markets below are copied from live /markets responses
// (2026-11-14), trimmed to the fields the code reads. Hand-written
// fixtures shaped to the code have passed here before while the code was
// wrong (docs/research/m15.md, the yes_bid_size story).

import { settlementIndex, eventOf, implies, groupKey, implicationPairs, contradictionCandidates, allocate, reviveEvent } from "../lib/ladder.js";
import { kalshiTakerFee } from "../lib/fees.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const LIVE = [
  {"ticker":"KXBTC-26NOV1317-T87999.99","strike_type":"greater","floor_strike":87999.99,"close_time":"2026-11-13T22:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is above 87999.99 at 5 PM EST on Nov 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXBTC-26NOV1317-T64000","strike_type":"less","cap_strike":64000,"close_time":"2026-11-13T22:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is below 64000 at 5 PM EST on Nov 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXBTC-26NOV1317-B64250","strike_type":"between","floor_strike":64000,"cap_strike":64499.99,"close_time":"2026-11-13T22:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is between 64000-64499.99 at 5 PM EST on Nov 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXBTC-26NOV1317-B64750","strike_type":"between","floor_strike":64500,"cap_strike":64999.99,"close_time":"2026-11-13T22:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is between 64500-64999.99 at 5 PM EST on Nov 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXBTCD-26NOV1317-T63999.99","strike_type":"greater","floor_strike":63999.99,"close_time":"2026-11-13T22:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before 5 PM EST is above 63999.99 at 5 PM EST on Nov 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXBTC15M-26NOV132345-45","strike_type":"greater_or_equal","floor_strike":66836.28,"close_time":"2026-11-14T04:45:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:45 PM EST on Nov 13, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:30 PM EST on November 13, 2026, then the market resolves to Yes."},
  {"ticker":"KXSOLE-26NOV1323-T42.75","strike_type":"less","cap_strike":42.75,"close_time":"2026-11-14T04:00:00Z","rules_primary":"If the simple average of the sixty seconds of CF Benchmarks' SOLUSD_RTI before 11 PM EST is below $42.75 at 11 PM EST on Nov 13, 2026, then the market resolves to Yes."},
];
const by = Object.fromEntries(LIVE.map(m => [m.ticker, m]));
const ev = t => eventOf(by[t]);

console.log("settlement index, from the rules");
ok(settlementIndex(by["KXBTC-26NOV1317-B64250"].rules_primary) === "BRTI", "the long name reads as BRTI");
ok(settlementIndex(by["KXBTC15M-26NOV132345-45"].rules_primary) === "BRTI", "the 15-minute wording reads as the same BRTI");
ok(settlementIndex(by["KXSOLE-26NOV1323-T42.75"].rules_primary) === "SOLUSD_RTI", "a bare index name reads as itself");
ok(settlementIndex("If there is a 60 second average of CF Benchmarks' Dogecoin Real-Time Index (DOGEUSD_RTI) before 6 PM EST is above 0.2449999 at 6 PM EST on Nov 12, 2026, then th") === "DOGEUSD_RTI", "Dogecoin's wording (a 60 second average) reads");
ok(settlementIndex("If the simple average of the 60 seconds of CF Benchmarks' Shiba Inu-Dollar Spot Rate (SHIBUSD_RTI) before 5 PM EST is above 0.000013499 at 5 PM EST on Nov 12, 2") === "SHIBUSD_RTI", "Shiba's wording (the 60 seconds) reads");
ok(settlementIndex("If Ripple has the highest return out of BTC (Bitcoin), ETH (Ethereum), SOL (Solana), XRP (Ripple), and HYPE (Hyperliquid) from Nov 12 - 6:30PM EST to 6:45PM EST") === null, "a coin race is not a strike market");
ok(settlementIndex("If the highest price of BRTI between now and Friday is above 90000...") === null, "a touch-style rule is not read as a close");
ok(settlementIndex("If the simple average of the sixty seconds of CF Benchmarks' some index before 5 PM") === null, "an unrecognised index name is left out, not guessed");

console.log("groups: same index, same close");
ok(groupKey(by["KXBTC-26NOV1317-B64250"]) === groupKey(by["KXBTCD-26NOV1317-T63999.99"]), "the range and above/below ladders at 5pm share a group");
ok(groupKey(by["KXBTC-26NOV1317-B64250"]) !== groupKey(by["KXBTC15M-26NOV132345-45"]), "a different close is a different group");
ok(groupKey(by["KXSOLE-26NOV1323-T42.75"]).startsWith("SOLUSD_RTI|"), "Solana groups on its own index");

console.log("events and implication");
ok(implies(ev("KXBTC-26NOV1317-B64250"), ev("KXBTCD-26NOV1317-T63999.99")), "the 64,000-64,499.99 bucket implies above 63,999.99");
ok(!implies(ev("KXBTCD-26NOV1317-T63999.99"), ev("KXBTC-26NOV1317-B64250")), "and not the other way");
ok(!implies(ev("KXBTC-26NOV1317-T64000"), ev("KXBTC-26NOV1317-B64250")), "below 64,000 and the bucket from 64,000 are disjoint");
ok(!implies(ev("KXBTC-26NOV1317-B64250"), ev("KXBTC-26NOV1317-B64750")), "adjacent buckets do not imply each other");
ok(implies(ev("KXBTC-26NOV1317-T87999.99"), ev("KXBTCD-26NOV1317-T63999.99")), "above 87,999.99 implies above 63,999.99");
ok(implies(ev("KXBTC-26NOV1317-B64250"), ev("KXBTC-26NOV1317-B64250")), "an event implies itself (equal strikes in two series)");

console.log("boundaries are exact");
const gt = { strike_type: "greater", floor_strike: 100 }, ge = { strike_type: "greater_or_equal", floor_strike: 100 };
ok(implies(eventOf(gt), eventOf(ge)), "S > 100 implies S >= 100");
ok(!implies(eventOf(ge), eventOf(gt)), "S >= 100 does not imply S > 100: it hinges on a tie, so it is left out");
ok(!implies(eventOf({ strike_type: "between", floor_strike: 100, cap_strike: 200 }), eventOf({ strike_type: "less", cap_strike: 200 })), "a bucket closed at 200 does not imply below 200");
ok(eventOf({ strike_type: "between", floor_strike: 200, cap_strike: 100 }) === null, "an inverted bucket is refused");
ok(eventOf({ strike_type: "greater" }) === null, "a missing strike is refused");
ok(eventOf({ strike_type: "custom", floor_strike: 1 }) === null, "a custom strike with nothing inside is refused");
const doge = {"ticker":"KXDOGED-26NOV1218-T0.2449999","strike_type":"custom","custom_strike":{"cap_strike":"","floor_strike":"0.2449999","round_digits":"7","strike_type":"greater"}};
const dogeLow = {"ticker":"KXDOGE-26NOV1218-T0.0100000","strike_type":"custom","custom_strike":{"cap_strike":"0.0100000","floor_strike":"","round_digits":"7","strike_type":"less"}};
ok(eventOf(doge)?.lo === 0.2449999 && eventOf(doge)?.loIn === false && eventOf(doge)?.hi === Infinity, "Dogecoin's custom strike reads as above 0.2449999");
ok(eventOf(dogeLow)?.hi === 0.01 && eventOf(dogeLow)?.lo === -Infinity, "and its low tail as below 0.01");
ok(!implies(eventOf(dogeLow), eventOf(doge)), "the two Dogecoin tails do not imply each other");

console.log("events survive the cache");
const viaJson = e => JSON.parse(JSON.stringify(e));
ok(!implies(viaJson(ev("KXBTC-26NOV1317-B64250")), viaJson(ev("KXBTCD-26NOV1317-T63999.99"))), "raw JSON loses the infinities (the bug this guards)");
ok(implies(reviveEvent(viaJson(ev("KXBTC-26NOV1317-B64250"))), reviveEvent(viaJson(ev("KXBTCD-26NOV1317-T63999.99")))), "revived, the bucket implies above 63,999.99 again");
ok(reviveEvent(viaJson(ev("KXBTC-26NOV1317-T64000"))).lo === -Infinity, "and below 64,000 is open below again");

console.log("pairs within a group");
const g = LIVE.filter(m => groupKey(m) === groupKey(by["KXBTC-26NOV1317-B64250"])).map(m => ({ ticker: m.ticker, ev: eventOf(m) }));
const pairs = implicationPairs(g).map(p => p.join(" > "));
ok(pairs.length === 3, `three implications among the five 5pm markets (${pairs.join("; ")})`);
ok(pairs.includes("KXBTC-26NOV1317-B64750 > KXBTCD-26NOV1317-T63999.99"), "the second bucket implies the above/below strike too");
const twin = implicationPairs([{ ticker: "A", ev: eventOf(gt) }, { ticker: "B", ev: eventOf(gt) }]);
ok(twin.length === 2, "the same event in two series pairs in both directions");

console.log("scoring the tape");
{
  // X: the 64,000-64,499.99 bucket, which implies Y: above 63,999.99.
  // Prints are synthetic here on purpose: this is arithmetic, and the
  // trade shape itself is pinned by scripts/m15-tape.test.mjs.
  const members = [
    { ticker: "X", ev: ev("KXBTC-26NOV1317-B64250") },
    { ticker: "Y", ev: ev("KXBTCD-26NOV1317-T63999.99") },
  ];
  const fee = (p, n) => kalshiTakerFee(p, n, 1, 0.0001);
  const feeCent = (p, n) => kalshiTakerFee(p, n, 1, 0.01);
  const opts = { maxWindowMs: 5000, fee };
  const T = 1_800_000_000_000;
  const tapes = new Map([
    ["X", [{ t: T, side: "no", price: 0.30, count: 10 }]],      // X's YES bid was 0.70
    ["Y", [{ t: T + 500, side: "yes", price: 0.60, count: 4 }]], // Y's YES ask was 0.60
  ]);
  const c = contradictionCandidates(members, tapes, opts);
  ok(c.length === 1 && c[0].x === "X" && c[0].y === "Y", "a bid on the narrower event above the ask on the wider one is a candidate");
  const a = allocate(c, { windowMs: 1000, fee });
  // 4 contracts: 4 x (1 - 0.30 - 0.60) = 0.40, fees 4 x 0.07 x 0.21 = 0.0588 and 4 x 0.07 x 0.24 = 0.0672.
  ok(a.length === 1 && a[0].size === 4 && Math.abs(a[0].edge - 0.274) < 1e-9, `priced at the smaller print, after both fees ($${a[0]?.edge?.toFixed(4)})`);

  const late = new Map([["X", tapes.get("X")], ["Y", [{ t: T + 2000, side: "yes", price: 0.60, count: 4 }]]]);
  const cl = contradictionCandidates(members, late, opts);
  ok(allocate(cl, { windowMs: 1000, fee }).length === 0 && allocate(cl, { windowMs: 5000, fee }).length === 1, "two seconds apart counts at the 5s window, not at 1s");

  const wrongWay = new Map([["Y", [{ t: T, side: "no", price: 0.30, count: 10 }]], ["X", [{ t: T, side: "yes", price: 0.60, count: 10 }]]]);
  ok(contradictionCandidates(members, wrongWay, opts).length === 0, "the wider event priced above the narrower one is no contradiction");

  const fair = new Map([["X", [{ t: T, side: "no", price: 0.45, count: 10 }]], ["Y", [{ t: T, side: "yes", price: 0.55, count: 10 }]]]);
  ok(contradictionCandidates(members, fair, opts).length === 0, "costs summing to exactly $1 are no edge");

  const feeEaten = new Map([["X", [{ t: T, side: "no", price: 0.49, count: 10 }]], ["Y", [{ t: T, side: "yes", price: 0.49, count: 10 }]]]);
  ok(contradictionCandidates(members, feeEaten, opts).length === 0, "2c under $1 at 50/50 is eaten by 3.5c of fees");

  const small = new Map([["X", [{ t: T, side: "no", price: 0.05, count: 1 }]], ["Y", [{ t: T, side: "yes", price: 0.93, count: 1 }]]]);
  const cs = contradictionCandidates(members, small, opts);
  ok(allocate(cs, { windowMs: 1000, fee }).length === 1 && allocate(cs, { windowMs: 1000, fee: feeCent }).length === 0, "one contract at 2c under $1 survives fees rounded to $0.0001 but not to the cent");

  // One YES print on Y (5 contracts) against two NO prints on X and one on
  // a second bucket: Y's contracts are used once in total.
  const three = [...members, { ticker: "X2", ev: ev("KXBTC-26NOV1317-B64750") }];
  const shared = new Map([
    ["X", [{ t: T, side: "no", price: 0.30, count: 5 }, { t: T + 100, side: "no", price: 0.25, count: 5 }]],
    ["X2", [{ t: T + 200, side: "no", price: 0.20, count: 5 }]],
    ["Y", [{ t: T + 50, side: "yes", price: 0.60, count: 5 }]],
  ]);
  const as = allocate(contradictionCandidates(three, shared, opts), { windowMs: 1000, fee });
  ok(Math.abs(as.reduce((s, x) => s + x.size, 0) - 5) < 1e-9, "a print's contracts are counted once across all its partners");
  ok(as[0].x === "X2" && as[0].noPrice === 0.20, "and go to the best edge first");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
