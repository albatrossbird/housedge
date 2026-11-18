// Late favourites in sports games (docs/research/sports-late-plan.md).
//
//   node scripts/sports-late.mjs --plumbing [--leagues=nba,nhl] [--limit=N]
//   node scripts/sports-late.mjs --score    [--leagues=...] [--limit=N]
//
// --plumbing reads Kalshi's settled game markets and ESPN's scoreboards and
// play-by-play, joins them and finds each game's decision times. It prints
// join rates, wall-clock coverage and the close lag, and reads no trade and
// no result. --score then reads Kalshi's trades in each decision window and
// scores the plan's bar. Public endpoints only, no key. Everything is cached
// under .sports-cache/ (gitignored); downloaded data is never committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { LEAGUES, decisionWall, joinGame, lateEntry } from "../lib/sportsLate.js";
import { kalshiEventOf, kalshiGameDate } from "../lib/sportsKeys.js";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const KB = "https://api.elections.kalshi.com/trade-api/v2", EB = "https://site.api.espn.com/apis/site/v2/sports";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const has = f => process.argv.includes(`--${f}`);
const CACHE = opt("cache", ".sports-cache"), PACE = Number(opt("pace", 220)), LIMIT = Number(opt("limit", 0)), SIZE = 10;
const LEAGUE_LIST = opt("leagues", Object.keys(LEAGUES).join(",")).split(",").filter(l => LEAGUES[l]);
const SCORE = has("score");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }

// The plan's windows, by the game's Eastern date.
const WINDOWS = [["A", "2025-10-01", "2026-03-01"], ["R", "2026-03-01", "2026-06-01"], ["B", "2026-09-01", "2026-11-18"]];
const windowOf = d => (WINDOWS.find(([, a, b]) => d >= a && d < b) || [null])[0];
const POINTS = [360, 180, 60], DELAYS = [5000, 10000, 30000], LOOK = 15000;
const PRIMARY = { point: 180, delay: 10000, lo: 0.75, hi: 0.97 };
// --primary-only: read only the primary decision point (the verdict), so it
// arrives in a third of the time; a later full run reuses the cache.
const ONLY_PRIMARY = has("primary-only");

const sleep = ms => new Promise(r => setTimeout(r, ms));
let kReq = 0, kRefused = 0, eReq = 0, nextAt = 0;
async function kget(path) {
  for (let i = 0; i < 7; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + PACE;
    await sleep(wait); kReq++;
    let r;
    try { r = await fetch(KB + path); } catch { await sleep(1500 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { kRefused++; const ra = Number(r.headers.get("retry-after")); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 7 tries`);
}
async function eget(path) {
  for (let i = 0; i < 5; i++) {
    eReq++; await sleep(60);
    let r;
    try { r = await fetch(EB + path); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`ESPN ${path.slice(0, 100)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`ESPN ${path.slice(0, 100)}: failed after 5 tries`);
}
const cachePath = (...p) => pathJoin(CACHE, ...p);
function cached(file) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined; }
function save(file, v) { writeFileSync(file + ".tmp", JSON.stringify(v)); renameSync(file + ".tmp", file); }
for (const d of ["kalshi", "espn-board", "espn-game", "trades"]) mkdirSync(cachePath(d), { recursive: true });

const cutoff = await kget("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts), tradeCut = Date.parse(cutoff.trades_created_ts);
const SINCE = Date.parse(`${WINDOWS[0][1]}T00:00:00Z`) - 86400000, UNTIL = Date.parse(`${WINDOWS[2][2]}T12:00:00Z`);

// ---- Kalshi: settled game markets, grouped into games ----
async function settledMarkets(series) {
  const file = cachePath("kalshi", `${series}.json`), c = cached(file);
  if (c) return c;
  const out = new Map(), keep = m => {
    const close = Date.parse(m.close_time);
    if (close >= SINCE && close < UNTIL && (m.result === "yes" || m.result === "no"))
      out.set(m.ticker, { ticker: m.ticker, name: m.yes_sub_title, close, result: m.result });
    return close;
  };
  let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=${series}&status=settled&min_close_ts=${Math.floor(Math.max(SINCE, marketCut - 86400000) / 1000)}&max_close_ts=${Math.floor(UNTIL / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    (d?.markets || []).forEach(keep); cursor = d?.cursor || "";
  } while (cursor);
  let oldest = Infinity; cursor = "";
  do {
    const d = await kget(`/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const m of d?.markets || []) oldest = Math.min(oldest, keep(m));
    cursor = d?.cursor || "";
  } while (cursor && oldest >= SINCE);
  const list = [...out.values()];
  save(file, list);
  return list;
}

// ---- ESPN: games by Eastern date, and a game's final-period plays ----
async function board(league, date) {
  const file = cachePath("espn-board", `${league}-${date}.json`), c = cached(file);
  if (c) return c;
  const L = LEAGUES[league], ymd = date.replace(/-/g, "");
  const games = [];
  for (const g of L.groups || [null]) {
    const d = await eget(`/${L.espn}/scoreboard?dates=${ymd}&limit=500${g ? `&groups=${g}` : ""}`);
    for (const e of d?.events || []) {
      const comp = e.competitions?.[0];
      if (!comp || games.some(x => x.id === e.id)) continue;
      games.push({ id: e.id, date, teams: (comp.competitors || []).map(t => ({ abbreviation: t.team?.abbreviation, location: t.team?.location, displayName: t.team?.displayName, shortDisplayName: t.team?.shortDisplayName, name: t.team?.name })) });
    }
  }
  save(file, games);
  return games;
}
async function gamePlays(league, id) {
  const file = cachePath("espn-game", `${league}-${id}.json`), c = cached(file);
  if (c) return c;
  const d = await eget(`/${LEAGUES[league].espn}/summary?event=${id}`);
  let plays = d?.plays;
  if (!plays) plays = [...(d?.drives?.previous || []), ...(d?.drives?.current ? [d.drives.current] : [])].flatMap(dr => dr.plays || []);
  plays = plays || [];
  const L = LEAGUES[league];
  const keep = plays.filter(p => p.period?.number === L.finalPeriod).map(p => ({ period: p.period.number, clock: p.clock?.displayValue, wallclock: p.wallclock || "" }));
  const last = plays.length ? plays[plays.length - 1] : null;
  const out = { plays: keep, total: plays.length, lastWall: last?.wallclock || "", lastPeriod: last?.period?.number ?? null };
  save(file, out);
  return out;
}
const shiftDate = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ---- build the games ----
const t0 = Date.now();
const games = [];
const plumb = {};
for (const league of LEAGUE_LIST) {
  const L = LEAGUES[league];
  const markets = await settledMarkets(L.series);
  const byEvent = new Map();
  for (const m of markets) { const e = kalshiEventOf(m.ticker); if (!byEvent.has(e)) byEvent.set(e, []); byEvent.get(e).push(m); }
  let evs = [...byEvent.entries()].filter(([e]) => windowOf(kalshiGameDate(e + "-X")));
  if (LIMIT) evs = evs.slice(0, LIMIT);
  const P = plumb[league] = { events: evs.length, notTwo: 0, joined: 0, why: {}, byWindow: {}, wallPlays: 0, finalPlays: 0, decided: {}, lagMin: [] };
  for (const [ev, ms] of evs) {
    const date = kalshiGameDate(ev + "-X"), win = windowOf(date);
    P.byWindow[win] = (P.byWindow[win] || 0) + 1;
    if (ms.length !== 2) { P.notTwo++; continue; }
    const kGame = { date, teams: ms.map(m => ({ name: m.name, code: m.ticker.split("-").pop() })) };
    const cands = [];
    for (const d of [shiftDate(date, -1), date, shiftDate(date, 1)]) cands.push(...await board(league, d));
    const j = joinGame(kGame, cands);
    if (!j.id) { P.why[j.why] = (P.why[j.why] || 0) + 1; if ((P.examples ||= []).length < 8) P.examples.push(`${date} ${kGame.teams.map(t => `${t.name} (${t.code})`).join(" v ")}`); continue; }
    P.joined++;
    const gp = await gamePlays(league, j.id);
    P.finalPlays += gp.plays.length; P.wallPlays += gp.plays.filter(p => p.wallclock).length;
    const walls = Object.fromEntries(POINTS.map(s => [s, decisionWall(gp.plays, league, s)]));
    for (const s of POINTS) if (walls[s]) P.decided[s] = (P.decided[s] || 0) + 1;
    const close = Math.max(...ms.map(m => m.close));
    if (gp.lastWall) { P.lagMin.push((close - Date.parse(gp.lastWall)) / 60000); ((P.lagBy ||= {})[win] ||= []).push((close - Date.parse(gp.lastWall)) / 60000); }
    games.push({ league, event: ev, date, win, markets: ms, close, walls });
  }
  console.error(`  ${league}: ${P.joined}/${P.events} joined, ${kReq} Kalshi + ${eReq} ESPN requests, ${Math.round((Date.now() - t0) / 60000)} min`);
}

const med = a => a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : null;
console.log(`LATE FAVOURITES IN SPORTS: ${SCORE ? "SCORE" : "PLUMBING (no trade or result is read)"}; windows ${WINDOWS.map(w => `${w[0]} ${w[1]}..${w[2]}`).join(", ")} (R is reference only)`);
console.log("league   games  A / R / B          not 2 mkts  joined   join%   wall-clock on final-period plays  decided at 6:00 / 3:00 / 1:00   close minus ESPN's last play (min): p10 / median / p90");
for (const [l, P] of Object.entries(plumb)) {
  const lag = [...P.lagMin].sort((a, b) => a - b), q = f => lag.length ? lag[Math.floor(f * (lag.length - 1))].toFixed(1) : "—";
  const tw = P.events - P.notTwo;
  console.log(`${l.padEnd(7)} ${String(P.events).padStart(6)}  ${["A", "R", "B"].map(w => P.byWindow[w] || 0).join(" / ").padEnd(18)} ${String(P.notTwo).padStart(10)}  ${String(P.joined).padStart(6)}  ${(tw ? 100 * P.joined / tw : 0).toFixed(1).padStart(5)}%   ${(P.finalPlays ? 100 * P.wallPlays / P.finalPlays : 0).toFixed(1).padStart(6)}%                        ${POINTS.map(s => P.decided[s] || 0).join(" / ").padEnd(30)} ${q(0.1)} / ${q(0.5)} / ${q(0.9)}`);
  if (Object.keys(P.why).length) console.log(`         not joined: ${Object.entries(P.why).map(([k, v]) => `${k} ${v}`).join("; ")}`);
  if (P.lagBy) console.log(`         close lag median by window: ${["A", "R", "B"].map(w => `${w} ${P.lagBy[w]?.length ? med(P.lagBy[w]).toFixed(1) : "—"}`).join(", ")} min`);
  if (P.examples?.length) console.log(`         e.g. ${P.examples.join("; ")}`);
}
console.log(`requests: Kalshi ${kReq} (${kRefused} refused and retried), ESPN ${eReq}; ${Math.round((Date.now() - t0) / 60000)} minutes`);
const failsPlumbing = Object.entries(plumb).filter(([, P]) => { const tw = P.events - P.notTwo; return tw && (P.joined / tw < 0.9 || (P.finalPlays && P.wallPlays / P.finalPlays < 0.95)); }).map(([l]) => l);
console.log(failsPlumbing.length ? `PLUMBING: ${failsPlumbing.join(", ")} under the plan's 90% join or 95% wall-clock: fix the join (aliases only) before scoring` : "PLUMBING: every league clears the plan's checks");
if (!SCORE) process.exit(0);

// ---- score ----
async function tradesIn(ticker, from, to) {
  const file = cachePath("trades", `${ticker}-${from}-${to}.json`), c = cached(file);
  if (c) return c;
  const base = to <= tradeCut ? "/historical/trades" : "/markets/trades";
  const out = []; let cursor = "";
  do {
    const d = await kget(`${base}?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(to / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d?.trades || []) { const x = parseTrade(raw); if (x && x.t >= from && x.t < to) out.push([x.t, x.side, x.price, x.count]); }
    cursor = d?.cursor || "";
    if (!(d?.trades || []).length) cursor = "";
  } while (cursor);
  save(file, out);
  return out;
}
async function gameTrades(g, from, to) {
  const all = [];
  for (const m of g.markets) for (const [t, side, price, count] of await tradesIn(m.ticker, from, to)) all.push({ t, side, price, count, market: m.ticker });
  return all.sort((a, b) => a.t - b.t);
}
const fee = p => kalshiTakerFee(p, SIZE, 1);   // all five series: taker multiplier 1 (fee_changes, read 2026-11-18)
const result = (g, ticker) => g.markets.find(m => m.ticker === ticker).result;
const trade = (g, x) => { const won = x.side === result(g, x.market); return { league: g.league, win: g.win, day: g.date, price: x.price, won, ctrs: SIZE, pnl: (won ? (1 - x.price) * SIZE : -x.price * SIZE) - fee(x.price) }; };

const cells = new Map();   // label -> trades
const add = (label, t) => { if (!cells.has(label)) cells.set(label, []); cells.get(label).push(t); };
let done = 0, noPrint = 0;
const tS = Date.now();
for (const g of games) {
  if (++done % 200 === 0) console.error(`  scored ${done}/${games.length} games, ${kReq} Kalshi requests, ${Math.round((Date.now() - tS) / 60000)} min`);
  for (const s of ONLY_PRIMARY ? [PRIMARY.point] : POINTS) {
    const w = g.walls[s];
    if (!w) continue;
    const tr = await gameTrades(g, w + DELAYS[0], w + DELAYS[DELAYS.length - 1] + LOOK);
    for (const d of DELAYS) for (const [blo, bhi] of [[0.75, 0.97], [0.75, 0.85], [0.85, 0.97]]) {
      const x = lateEntry(tr, w + d, { lookMs: LOOK, lo: blo, hi: bhi });
      const label = `${s}|${d}|${blo}-${bhi}`;
      if (x) add(label, trade(g, x));
      else if (s === PRIMARY.point && d === PRIMARY.delay && blo === PRIMARY.lo && bhi === PRIMARY.hi && g.win !== "R") noPrint++;
    }
  }
  // The paper's measure: 10 minutes before the ACTUAL close (not knowable live).
  if (ONLY_PRIMARY) continue;
  const pc = g.close - 600000;
  const x = lateEntry(await gameTrades(g, pc, pc + LOOK), pc, { lookMs: LOOK });
  if (x) add("paper", trade(g, x));
}

const cents = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`;
const tt = v => v == null ? "—" : v.toFixed(2);
function row(label, ts) {
  if (!ts.length) return `  ${label.padEnd(34)}      0`;
  const S = dayStats(ts), won = ts.filter(x => x.won).length / ts.length, paid = ts.reduce((a, x) => a + x.price, 0) / ts.length;
  return `  ${label.padEnd(34)} ${String(ts.length).padStart(6)}  ${(100 * won).toFixed(1).padStart(5)}%  ${paid.toFixed(3)}  ${cents(S.perCtr).padStart(8)}  t ${tt(S.t).padStart(5)}  days ${String(S.days).padStart(4)}  $${(S.pnl / Math.max(S.days, 1)).toFixed(2).padStart(6)}/day`;
}
const primaryLabel = `${PRIMARY.point}|${PRIMARY.delay}|${PRIMARY.lo}-${PRIMARY.hi}`;
const prim = (cells.get(primaryLabel) || []);
const AB = prim.filter(x => x.win !== "R"), A = prim.filter(x => x.win === "A"), Bw = prim.filter(x => x.win === "B");
console.log(`\nTHE PRIMARY CELL: 3:00 left in the final period, +10s, first in-band taker print within 15s, 75-97c, ${SIZE} contracts, taker fee, held to settlement`);
console.log("                                      trades    won   paid  per ctr       t        days      at 10 contracts");
console.log(row("A + B (scored)", AB));
console.log(row("A  2025-10-01..2026-02-28", A));
console.log(row("B  2026-09-01..2026-11-17", Bw));
console.log(`  (games decided at 3:00 in A + B with no in-band print within 15s: ${noPrint})`);
const S = dayStats(AB), SA = dayStats(A), SB = dayStats(Bw);
const pass = S.perCtr > 0 && S.t >= 2 && SA.perCtr > 0 && SB.perCtr > 0 && AB.length >= 200;
console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL"}  (needs per ctr > 0 at t >= 2 pooled, positive in A and in B, 200+ trades: ${cents(S.perCtr)} t ${tt(S.t)}; A ${cents(SA.perCtr)}; B ${cents(SB.perCtr)}; ${AB.length} trades)`);
// Risk at 10 contracts.
const byDay = new Map(); for (const x of AB) byDay.set(x.day, (byDay.get(x.day) || 0) + x.pnl);
let streak = 0, worstStreak = 0; for (const x of [...AB].sort((a, b) => a.day.localeCompare(b.day))) { streak = x.won ? 0 : streak + 1; worstStreak = Math.max(worstStreak, streak); }
console.log(`  worst day ${cents(Math.min(...byDay.values()) / 100).replace("c", "").replace(/^([+-])/, "$1$")} at 10 contracts; longest losing run ${worstStreak} trades`);

console.log("\nREFERENCE ONLY (never a second chance; a cell that passes alone is a candidate for a fresh test on games after 2026-11-17)");
console.log("                                      trades    won   paid  per ctr       t        days      at 10 contracts");
for (const l of LEAGUE_LIST) console.log(row(`league ${l}, A + B`, AB.filter(x => x.league === l)));
for (const s of POINTS) for (const d of DELAYS) {
  if (s === PRIMARY.point && d === PRIMARY.delay) continue;
  console.log(row(`${s / 60}:00 left, +${d / 1000}s, 75-97c, A + B`, (cells.get(`${s}|${d}|0.75-0.97`) || []).filter(x => x.win !== "R")));
}
for (const b of ["0.75-0.85", "0.85-0.97"]) console.log(row(`3:00, +10s, ${b.replace("0.", "").replace("-0.", "-")}c, A + B`, (cells.get(`180|10000|${b}`) || []).filter(x => x.win !== "R")));
console.log(row("primary rule in R (the paper's period)", prim.filter(x => x.win === "R")));
const paper = cells.get("paper") || [];
console.log(row("10 min before the ACTUAL close, A + B", paper.filter(x => x.win !== "R")));
console.log(row("10 min before the ACTUAL close, R", paper.filter(x => x.win === "R")));
console.log(`\nrequests: Kalshi ${kReq} (${kRefused} refused), ESPN ${eReq}; ${Math.round((Date.now() - t0) / 60000)} minutes. Upper bound: a print says someone traded there, not that 10 more were available.`);
