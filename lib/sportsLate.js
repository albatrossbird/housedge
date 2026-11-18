// Late favourites in sports games (docs/research/sports-late-plan.md):
// the pure parts. Joining a Kalshi game to ESPN's, reading "N seconds
// left in the final period" off ESPN's play-by-play, and taking the
// first in-band taker print after the decision time.

import { teamNameKey } from "./sportsKeys.js";

// Final regulation period, its length, and whether ESPN's clock counts
// time remaining (down) or time elapsed (up: NHL, checked 2026-11-18).
export const LEAGUES = {
  nba: { series: "KXNBAGAME", espn: "basketball/nba", finalPeriod: 4, periodSecs: 720, clockUp: false, halfAfter: 2, otherBreak: 3 },
  nhl: { series: "KXNHLGAME", espn: "hockey/nhl", finalPeriod: 3, periodSecs: 1200, clockUp: true, halfAfter: 2, otherBreak: 1 },
  nfl: { series: "KXNFLGAME", espn: "football/nfl", finalPeriod: 4, periodSecs: 900, clockUp: false, halfAfter: 2, otherBreak: 3 },
  ncaaf: { series: "KXNCAAFGAME", espn: "football/college-football", finalPeriod: 4, periodSecs: 900, clockUp: false, groups: ["80", "81"], halfAfter: 2, otherBreak: 3 },
  ncaamb: { series: "KXNCAAMBGAME", espn: "basketball/mens-college-basketball", finalPeriod: 2, periodSecs: 1200, clockUp: false, groups: ["50"], halfAfter: 1, otherBreak: null },
};
// halfAfter: the period whose end starts the halftime break (NHL has none;
// its 2nd intermission stands in). otherBreak: the reference break (end of
// the 3rd quarter; NHL's 1st intermission). sports-half-plan.md.

// "3:05" -> 185, "0.4" -> 0.4, "12:00" -> 720.
export function clockSecs(s) {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(String(s || "").trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(String(s || "").trim());
  return Number.isFinite(n) && String(s || "").trim() !== "" ? n : null;
}

// plays: [{ period, clock, wallclock }] in feed order. The wall-clock ms of
// the first play in the final regulation period with <= secsLeft remaining,
// or null.
export function decisionWall(plays, league, secsLeft) {
  const L = typeof league === "string" ? LEAGUES[league] : league;
  for (const p of plays || []) {
    if (p.period !== L.finalPeriod) continue;
    const c = clockSecs(p.clock);
    if (c == null) continue;
    const left = L.clockUp ? L.periodSecs - c : c;
    if (left <= secsLeft + 1e-9) { const w = Date.parse(p.wallclock); return Number.isFinite(w) ? w : null; }
  }
  return null;
}

// Does a Kalshi team (name as Kalshi writes it, and its ticker code) name
// this ESPN team? Kalshi writes cities: "Portland", "Kent St.", "Miami
// (OH)", and for a shared city a letter: "Los Angeles C", "New York Y".
// ESPN writes "San José State" and files the Clippers under "LA"; neither
// venue's spelling is wrong, so both are folded before comparing.
const key = s => teamNameKey(String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")).replace(/^la\b/, "los angeles");
// The codes agree where the names do not ("Appalachian St." is ESPN's "App
// State", both APP). A code alone is trusted only because joinGame needs
// BOTH teams of one game on the same date to match.
export function teamMatches(kName, kCode, t) {
  const k = key(kName);
  if (!k) return false;
  const loc = key(t.location), full = key(t.displayName), short = key(t.shortDisplayName), nick = key(t.name);
  if (k === loc || k === full || (short && k === short)) return true;
  const letter = /^(.+) ([a-z])$/.exec(k);
  if (letter && letter[1] === loc && nick.startsWith(letter[2])) return true;
  return !!kCode && String(t.abbreviation || "").toUpperCase() === String(kCode).toUpperCase();
}

// kGame: { date: "YYYY-MM-DD", teams: [{ name, code }, { name, code }] }.
// espnGames: [{ id, date (ET day of the game), teams: [espnTeam, espnTeam] }].
// -> { id } when exactly one game matches both teams (same ET date
// preferred over a neighbouring one), else { why }.
export function joinGame(kGame, espnGames) {
  const fits = espnGames.filter(g => {
    if (g.teams.length !== 2) return false;
    const [a, b] = kGame.teams, [x, y] = g.teams;
    return (teamMatches(a.name, a.code, x) && teamMatches(b.name, b.code, y)) || (teamMatches(a.name, a.code, y) && teamMatches(b.name, b.code, x));
  });
  if (!fits.length) return { why: "no ESPN game with both teams" };
  const same = fits.filter(g => g.date === kGame.date);
  const pool = same.length ? same : fits;
  return pool.length === 1 ? { id: pool[0].id } : { why: "more than one ESPN game fits" };
}

// trades: parsed taker prints from the game's markets, each with
// { t, side, price, count, market } where market is the ticker it traded
// on. The first one in [from, from + lookMs) that BUYS a side priced in
// [lo, hi], or null.
// pick, when given, must also accept the print (the margin test: it must
// buy the leader).
export function lateEntry(trades, from, { lookMs = 15000, lo = 0.75, hi = 0.97, pick = null } = {}) {
  let best = null;
  for (const x of trades) {
    if (x.t < from || x.t >= from + lookMs) continue;
    if (pick && !pick(x)) continue;
    if (x.price < lo - 1e-9 || x.price > hi + 1e-9) continue;
    if (!best || x.t < best.t) best = x;
  }
  return best;
}

// plays: [{ period, wallclock }]. Per period, the earliest and latest
// wall-clock ms seen: { [period]: { first, last } }. Plays with no
// wall-clock are skipped.
export function periodBounds(plays) {
  const out = {};
  for (const p of plays || []) {
    const w = Date.parse(p.wallclock || "");
    if (!Number.isFinite(w) || p.period == null) continue;
    const b = out[p.period] ||= { first: w, last: w };
    if (w < b.first) b.first = w;
    if (w > b.last) b.last = w;
  }
  return out;
}

// The break after period `after`: { end, restart, minutes } from ESPN's
// last play of that period to the first play of the next, or null when
// either side is missing.
export function breakAfter(bounds, after) {
  const a = bounds?.[after], b = bounds?.[after + 1];
  if (!a || !b) return null;
  return { end: a.last, restart: b.first, minutes: (b.first - a.last) / 60000 };
}

// late: final-period plays as [clock, wallclock, homeScore, awayScore], in
// feed order. The first with <= secsLeft remaining, as decisionWall picks
// it: { wall, home, away }, or null. Scores may be null.
export function decisionPlay(late, league, secsLeft) {
  const L = typeof league === "string" ? LEAGUES[league] : league;
  for (const [clock, wallclock, home, away] of late || []) {
    const c = clockSecs(clock);
    if (c == null) continue;
    const left = L.clockUp ? L.periodSecs - c : c;
    if (left <= secsLeft + 1e-9) { const w = Date.parse(wallclock); return Number.isFinite(w) ? { wall: w, home, away } : null; }
  }
  return null;
}

// The Kalshi market of the team that leads at a decision play, or a reason.
// markets: [{ ticker, name }]; homeTeam/awayTeam: ESPN team objects.
export function leaderMarket(dp, markets, homeTeam, awayTeam) {
  if (!dp || dp.home == null || dp.away == null) return { why: "no score" };
  if (dp.home === dp.away) return { why: "tied" };
  const team = dp.home > dp.away ? homeTeam : awayTeam;
  const hits = markets.filter(m => team && teamMatches(m.name, m.ticker.split("-").pop(), team));
  if (hits.length !== 1) return { why: "leader does not map to one market" };
  return { ticker: hits[0].ticker, lead: Math.abs(dp.home - dp.away) };
}

// ESPN's football feeds carry stray wall-clocks: a 2nd-quarter play
// stamped after the restart, a kickoff stamped at exactly midnight UTC as
// a placeholder. So breaks are read in FEED order (sports-half-plan.md,
// plumbing note): order is [[period, wallMs], ...] in feed order, with
// placeholders already dropped (see wallOf).
export const wallOf = s => (!s || /T00:00:00(\.000)?Z$/.test(s) ? null : (Number.isFinite(Date.parse(s)) ? Date.parse(s) : null));

// The break after period `after`: from the period's last play in feed
// order to the next period's first play stamped after it.
export function breakInFeed(order, after) {
  let end = null;
  for (const [p, w] of order || []) if (p === after) end = w;
  if (end == null) return null;
  for (const [p, w] of order) if (p === after + 1 && w > end) return { end, restart: w, minutes: (w - end) / 60000 };
  return null;
}

// The game's first play in feed order (the pre-game point).
export function firstInFeed(order) {
  return order && order.length ? order[0][1] : null;
}
