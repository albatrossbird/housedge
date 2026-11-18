// lib/sportsLate.js, worked by hand. Team shapes copied from ESPN's
// scoreboard and Kalshi's markets on 2026-11-18.

import { clockSecs, decisionWall, teamMatches, joinGame, lateEntry } from "../lib/sportsLate.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

console.log("the clock");
{
  ok(clockSecs("3:05") === 185 && clockSecs("12:00") === 720 && clockSecs("0.4") === 0.4 && clockSecs("") === null, "M:SS and bare seconds parse; empty does not");
  const nba = [
    { period: 3, clock: "1:00", wallclock: "2026-11-18T02:50:00Z" },
    { period: 4, clock: "12:00", wallclock: "2026-11-18T03:05:13Z" },
    { period: 4, clock: "3:12", wallclock: "2026-11-18T03:25:00Z" },
    { period: 4, clock: "2:58", wallclock: "2026-11-18T03:25:40Z" },
    { period: 4, clock: "0.4", wallclock: "2026-11-18T03:36:56Z" },
  ];
  ok(decisionWall(nba, "nba", 180) === Date.parse("2026-11-18T03:25:40Z"), "NBA: the first 4th-quarter play at 3:00 or less, not the 3rd quarter's 1:00");
  ok(decisionWall(nba, "nba", 360) === Date.parse("2026-11-18T03:25:00Z"), "and at 6:00 the 3:12 play is already inside");
  // NHL counts up: 17:00 elapsed in the 3rd is 3:00 left.
  const nhl = [
    { period: 3, clock: "0:00", wallclock: "2026-11-16T02:35:11Z" },
    { period: 3, clock: "16:59", wallclock: "2026-11-16T03:05:00Z" },
    { period: 3, clock: "17:03", wallclock: "2026-11-16T03:06:10Z" },
  ];
  ok(decisionWall(nhl, "nhl", 180) === Date.parse("2026-11-16T03:06:10Z"), "NHL: the clock counts up, so 17:03 elapsed is under 3:00 left");
  ok(decisionWall([{ period: 4, clock: "5:00", wallclock: "2026-11-18T03:00:00Z" }], "nba", 180) === null, "a game whose feed never reaches 3:00 left gives no decision");
  ok(decisionWall([{ period: 4, clock: "2:00", wallclock: "" }], "nba", 180) === null, "a play without a wall-clock gives none");
}

console.log("teams and the join");
{
  const POR = { abbreviation: "POR", location: "Portland", displayName: "Portland Trail Blazers", shortDisplayName: "Trail Blazers", name: "Trail Blazers" };
  const MIN = { abbreviation: "MIN", location: "Minnesota", displayName: "Minnesota Timberwolves", shortDisplayName: "Timberwolves", name: "Timberwolves" };
  const LAC = { abbreviation: "LAC", location: "Los Angeles", displayName: "LA Clippers", shortDisplayName: "Clippers", name: "Clippers" };
  const LAL = { abbreviation: "LAL", location: "Los Angeles", displayName: "Los Angeles Lakers", shortDisplayName: "Lakers", name: "Lakers" };
  const KENT = { abbreviation: "KENT", location: "Kent State", displayName: "Kent State Golden Flashes", shortDisplayName: "Kent State", name: "Golden Flashes" };
  const MOH = { abbreviation: "M-OH", location: "Miami (OH)", displayName: "Miami (OH) RedHawks", shortDisplayName: "Miami (OH)", name: "RedHawks" };
  const MIA = { abbreviation: "MIA", location: "Miami", displayName: "Miami Hurricanes", shortDisplayName: "Miami", name: "Hurricanes" };
  ok(teamMatches("Portland", "POR", POR) && !teamMatches("Portland", "POR", MIN), "a city names its team and not another");
  ok(teamMatches("Los Angeles C", "LAC", LAC) && !teamMatches("Los Angeles C", "LAC", LAL), "'Los Angeles C' is the Clippers, not the Lakers");
  ok(teamMatches("Kent St.", "KENT", KENT), "'Kent St.' is Kent State");
  ok(teamMatches("Miami (OH)", "MOH", MOH) && !teamMatches("Miami (OH)", "MOH", MIA) && !teamMatches("Miami", "MIA", MOH), "Miami (OH) and Miami are different schools");
  const CLIP = { abbreviation: "LAC", location: "LA", displayName: "LA Clippers", shortDisplayName: "Clippers", name: "Clippers" };
  ok(teamMatches("Los Angeles C", "LAC", CLIP) && !teamMatches("Los Angeles L", "LAL", CLIP), "ESPN's 'LA' is Los Angeles: the Clippers match, the Lakers do not");
  const SJSU = { abbreviation: "SJSU", location: "San José State", displayName: "San José State Spartans", shortDisplayName: "San José St", name: "Spartans" };
  ok(teamMatches("San Jose St.", "SJSU", SJSU), "accents are folded: 'San Jose St.' is 'San José State'");
  const APP = { abbreviation: "APP", location: "App State", displayName: "App State Mountaineers", shortDisplayName: "App State", name: "Mountaineers" };
  ok(teamMatches("Appalachian St.", "APP", APP) && !teamMatches("Appalachian St.", "APST", APP), "where the names differ the code decides, and only an equal code");
  const g = { date: "2026-11-17", teams: [{ name: "Portland", code: "POR" }, { name: "Minnesota", code: "MIN" }] };
  ok(joinGame(g, [{ id: "1", date: "2026-11-17", teams: [MIN, POR] }]).id === "1", "home and away in either order");
  ok(/no ESPN/.test(joinGame(g, [{ id: "2", date: "2026-11-17", teams: [MIN, LAC] }]).why), "one team right is not a match");
  ok(joinGame(g, [{ id: "3", date: "2026-11-16", teams: [POR, MIN] }, { id: "4", date: "2026-11-17", teams: [MIN, POR] }]).id === "4", "the same Eastern date wins over a neighbouring one");
  ok(/more than one/.test(joinGame(g, [{ id: "5", date: "2026-11-16", teams: [POR, MIN] }, { id: "6", date: "2026-11-18", teams: [MIN, POR] }]).why), "two neighbours and no same-day game is refused");
}

console.log("the entry");
{
  const T0 = 1_000_000;
  const tr = [
    { t: T0 - 1000, side: "yes", price: 0.80, count: 5, market: "A" },   // before the decision
    { t: T0 + 2000, side: "no", price: 0.30, count: 9, market: "A" },    // a buy of the underdog
    { t: T0 + 4000, side: "yes", price: 0.985, count: 9, market: "B" },  // above 97c
    { t: T0 + 6000, side: "no", price: 0.82, count: 3, market: "B" },    // the favourite, through the other market
    { t: T0 + 7000, side: "yes", price: 0.80, count: 50, market: "A" },
  ];
  const e = lateEntry(tr, T0);
  ok(e && e.t === T0 + 6000 && e.market === "B" && e.side === "no", "the first in-band buy after the decision, on either market, either side");
  ok(lateEntry(tr, T0 + 7500) === null, "nothing in the window: no trade");
  ok(lateEntry(tr, T0, { lo: 0.85, hi: 0.97 }) === null, "a narrower band can leave none");
  ok(lateEntry([{ t: T0 + 15000, side: "yes", price: 0.9, count: 1, market: "A" }], T0) === null, "the window is half-open at 15 seconds");
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
