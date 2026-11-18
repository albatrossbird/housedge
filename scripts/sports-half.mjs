// Favourites at halftime in sports games (docs/research/sports-half-plan.md).
//
//   node scripts/sports-half.mjs --plumbing [--leagues=nba,nhl] [--limit=N]
//   node scripts/sports-half.mjs --score [--primary-only] [--leagues=...]
//   node scripts/sports-half.mjs --margin [--leagues=...]
//
// --margin scores the lead-and-price grid of sports-margin-plan.md: chosen
// on window A, tested once on R + B. Its trade windows are the late test's
// (decision +5s to +45s), so they come from the same cache.
//
// The second look after sports-late.mjs failed at 3:00 left. Same games,
// same joins, same caches (.sports-cache/, gitignored), plus each game's
// per-period wall-clock bounds from ESPN's play-by-play. --plumbing reads
// no trade and no result. The fetch helpers are copied from
// sports-late.mjs rather than shared, so that script stays as it ran.

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { LEAGUES, joinGame, lateEntry, periodBounds, breakAfter, decisionPlay, leaderMarket } from "../lib/sportsLate.js";
import { kalshiEventOf, kalshiGameDate } from "../lib/sportsKeys.js";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const KB = "https://api.elections.kalshi.com/trade-api/v2", EB = "https://site.api.espn.com/apis/site/v2/sports";
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const has = f => process.argv.includes(`--${f}`);
const CACHE = opt("cache", ".sports-cache"), PACE = Number(opt("pace", 220)), LIMIT = Number(opt("limit", 0)), SIZE = 10;
const LEAGUE_LIST = opt("leagues", Object.keys(LEAGUES).join(",")).split(",").filter(l => LEAGUES[l]);
const MARGIN = has("margin"), SCORE = has("score") || MARGIN;
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }

// The plan's windows, by the game's Eastern date.
const WINDOWS = [["A", "2025-10-01", "2026-03-01"], ["R", "2026-03-01", "2026-06-01"], ["B", "2026-09-01", "2026-11-18"]];
const windowOf = d => (WINDOWS.find(([, a, b]) => d >= a && d < b) || [null])[0];
const DELAY = 60000, LOOK = 300000, PRE = 600000;
// --primary-only: read only halftime (the verdict); a later full run
// reuses the cache for the reference rows.
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
for (const d of ["kalshi", "espn-board", "espn-half", "trades"]) mkdirSync(cachePath(d), { recursive: true });

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

// ---- ESPN: a game's per-period wall-clock bounds, its home and away
// teams, and its final-period plays with the score (the margin test,
// sports-margin-plan.md, reads the same cache) ----
const teamOf = c => ({ abbreviation: c?.team?.abbreviation, location: c?.team?.location, displayName: c?.team?.displayName, shortDisplayName: c?.team?.shortDisplayName, name: c?.team?.name });
async function gameBounds(league, id) {
  const file = cachePath("espn-half", `${league}-${id}.json`), c = cached(file);
  if (c) return c;
  const d = await eget(`/${LEAGUES[league].espn}/summary?event=${id}`);
  let plays = d?.plays;
  if (!plays) plays = [...(d?.drives?.previous || []), ...(d?.drives?.current ? [d.drives.current] : [])].flatMap(dr => dr.plays || []);
  plays = plays || [];
  const bounds = periodBounds(plays.map(p => ({ period: p.period?.number, wallclock: p.wallclock || "" })));
  const comps = d?.header?.competitions?.[0]?.competitors || [];
  const fp = LEAGUES[league].finalPeriod;
  const late = plays.filter(p => p.period?.number === fp).map(p => [p.clock?.displayValue ?? "", p.wallclock || "", p.homeScore ?? null, p.awayScore ?? null]);
  const out = { bounds, home: teamOf(comps.find(x => x.homeAway === "home")), away: teamOf(comps.find(x => x.homeAway === "away")), late };
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
  const P = plumb[league] = { events: evs.length, joined: 0, half: 0, other: 0, pre: 0, breaks: [], over6: 0 };
  for (const [ev, ms] of evs) {
    const date = kalshiGameDate(ev + "-X"), win = windowOf(date);
    if (ms.length !== 2) continue;
    const kGame = { date, teams: ms.map(m => ({ name: m.name, code: m.ticker.split("-").pop() })) };
    const cands = [];
    for (const d of [shiftDate(date, -1), date, shiftDate(date, 1)]) cands.push(...await board(league, d));
    const j = joinGame(kGame, cands);
    if (!j.id) continue;
    P.joined++;
    const gb = await gameBounds(league, j.id), b = gb.bounds;
    const half = breakAfter(b, L.halfAfter), other = L.otherBreak ? breakAfter(b, L.otherBreak) : null;
    const first = b[1]?.first ?? null;
    if (half) { P.half++; P.breaks.push(half.minutes); if (half.minutes > 6) P.over6++; }
    if (other) P.other++;
    if (first) P.pre++;
    games.push({ league, event: ev, date, win, markets: ms, half, other, first, gb });
  }
  console.error(`  ${league}: ${P.joined}/${P.events} joined, ${kReq} Kalshi + ${eReq} ESPN requests, ${Math.round((Date.now() - t0) / 60000)} min`);
}

const pct = (a, b) => (b ? 100 * a / b : 0).toFixed(1);
console.log(`FAVOURITES AT HALFTIME: ${SCORE ? "SCORE" : "PLUMBING (no trade or result is read)"}; windows ${WINDOWS.map(w => `${w[0]} ${w[1]}..${w[2]}`).join(", ")} (R is reference only)`);
console.log("league   joined  halftime found   break (min) p10 / median / p90   break > 6 min   other break found   pre-game found");
let plumbOk = true;
for (const [l, P] of Object.entries(plumb)) {
  const br = [...P.breaks].sort((a, b) => a - b), q = f => br.length ? br[Math.floor(f * (br.length - 1))].toFixed(1) : "—";
  const medB = br.length ? br[Math.floor(0.5 * (br.length - 1))] : 0;
  const okL = P.half >= 0.95 * P.joined && medB >= 10 && medB <= 25 && P.over6 >= 0.9 * P.half && P.pre >= 0.95 * P.joined;
  if (!okL) plumbOk = false;
  console.log(`${l.padEnd(7)} ${String(P.joined).padStart(6)}  ${pct(P.half, P.joined).padStart(6)}%          ${q(0.1)} / ${q(0.5)} / ${q(0.9)}`.padEnd(66) + `${pct(P.over6, P.half).padStart(6)}%        ${LEAGUES[l].otherBreak ? pct(P.other, P.joined) + "%" : "—"}`.padEnd(38) + `${pct(P.pre, P.joined)}%   ${okL ? "" : "<- FAILS a plumbing check"}`);
}
console.log(`PLUMBING: ${plumbOk ? "every league clears the plan's checks" : "a league FAILS; fix before scoring"}`);
if (!SCORE) { console.log(`requests: Kalshi ${kReq}, ESPN ${eReq}; ${Math.round((Date.now() - t0) / 60000)} minutes`); process.exit(0); }
if (!plumbOk && !MARGIN) { console.error("refusing to score: plumbing fails"); process.exit(1); }

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


const cents = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`;
const tt = v => v == null ? "—" : v.toFixed(2);
function row(label, ts) {
  if (!ts.length) return `  ${label.padEnd(36)}      0`;
  const S = dayStats(ts), won = ts.filter(x => x.won).length / ts.length, paid = ts.reduce((a, x) => a + x.price, 0) / ts.length;
  return `  ${label.padEnd(36)} ${String(ts.length).padStart(6)}  ${(100 * won).toFixed(1).padStart(5)}%  ${paid.toFixed(3)}  ${cents(S.perCtr).padStart(8)}  t ${tt(S.t).padStart(5)}  days ${String(S.days).padStart(4)}  $${(S.pnl / Math.max(S.days, 1)).toFixed(2).padStart(6)}/day`;
}
if (MARGIN) {
  const POINTS = [360, 180, 60], CAPS = [0.80, 0.88, 0.95];
  const LEADS = { nba: [6, 10, 15], ncaamb: [6, 10, 15], nfl: [4, 9, 17], ncaaf: [4, 9, 17], nhl: [1, 2, 3] };
  const mcells = new Map(), madd = (k, t) => { if (!mcells.has(k)) mcells.set(k, []); mcells.get(k).push(t); };
  const mp = {};   // plumbing per league: decided, scored, mapped, why
  let done = 0; const tS = Date.now();
  for (const g of games) {
    if (++done % 500 === 0) console.error(`  margin: ${done}/${games.length} games, ${kReq} Kalshi requests, ${Math.round((Date.now() - tS) / 60000)} min`);
    const P = mp[g.league] ||= { decided: 0, scored: 0, mapped: 0, why: {} };
    for (const s of POINTS) {
      const dp = decisionPlay(g.gb.late, g.league, s);
      if (!dp) continue;
      P.decided++;
      if (dp.home != null && dp.away != null) P.scored++;
      const lm = leaderMarket(dp, g.markets, g.gb.home, g.gb.away);
      if (!lm.ticker) { P.why[lm.why] = (P.why[lm.why] || 0) + 1; continue; }
      P.mapped++;
      if (lm.lead < LEADS[g.league][0]) continue;
      // The late test's window, so its cache serves this read.
      const tr = await gameTrades(g, dp.wall + 5000, dp.wall + 45000);
      const pick = x => (x.market === lm.ticker) === (x.side === "yes");
      for (const M of LEADS[g.league]) if (lm.lead >= M) for (const cap of CAPS) {
        const x = lateEntry(tr, dp.wall + 10000, { lookMs: 15000, lo: 0.5, hi: cap, pick });
        if (x) madd(`${g.league}|${s}|${M}|${cap}`, trade(g, x));
      }
    }
  }
  if (process.env.MDEBUG) for (const [k, v] of mcells) console.error(`  cell ${k}: ${v.length} (${v.map(x => x.win).join("")})`);
  console.log(`\nBUY THE LEADER LATE, BY LEAD AND PRICE (sports-margin-plan.md): chosen on A, tested once on R + B`);
  console.log("plumbing: league  decisions  score known  leader maps to one market (of decisions with a leader)");
  let mOk = true;
  for (const [l, P] of Object.entries(mp)) {
    const withLeader = P.scored - (P.why.tied || 0);
    const ok1 = P.scored >= 0.95 * P.decided, ok2 = P.mapped >= 0.99 * withLeader;
    if (!ok1 || !ok2) mOk = false;
    console.log(`  ${l.padEnd(7)} ${String(P.decided).padStart(9)}  ${pct(P.scored, P.decided).padStart(6)}%     ${pct(P.mapped, withLeader).padStart(6)}%   ${JSON.stringify(P.why)} ${ok1 && ok2 ? "" : "<- FAILS"}`);
  }
  if (!mOk) { console.log("PLUMBING FAILS: not scored"); process.exit(1); }
  const HEADM = "                                        trades    won   paid  per ctr       t        days      at 10 contracts";
  const ofW = (ts, ws) => ts.filter(x => ws.includes(x.win));
  const chosen = [];
  for (const l of LEAGUE_LIST) {
    console.log(`\n${l}: the grid on A (choosing only)`);
    console.log(HEADM);
    let best = null;
    for (const s of POINTS) for (const M of LEADS[l]) for (const cap of CAPS) {
      const k = `${l}|${s}|${M}|${cap}`, a = ofW(mcells.get(k) || [], ["A"]);
      console.log(row(`${s / 60}:00 left, lead >= ${M}, 50-${Math.round(cap * 100)}c`, a));
      if (a.length < 60) continue;
      const S = dayStats(a);
      if (!(S.perCtr > 0)) continue;
      if (!best || S.t > best.t || (S.t === best.t && a.length > best.n)) best = { k, t: S.t, n: a.length, s, M, cap };
    }
    if (!best || best.t < 1) { console.log(`  ${l}: no cell with 60+ trades, a positive mean and t >= 1 on A: dropped, not tested`); continue; }
    console.log(`  ${l}: chosen ${best.s / 60}:00 left, lead >= ${best.M}, 50-${Math.round(best.cap * 100)}c (t ${tt(best.t)} on A, ${best.n} trades)`);
    chosen.push({ l, ...best });
  }
  console.log(`\nTHE TEST: each chosen rule on R + B, once. PASS needs per ctr > 0 at t >= 2.3 on R + B, positive in R and in B (B alone where R has no games), 60+ trades`);
  console.log(HEADM);
  for (const c of chosen) {
    const all = mcells.get(c.k) || [], RB = ofW(all, ["R", "B"]), R = ofW(all, ["R"]), B = ofW(all, ["B"]);
    console.log(row(`${c.l} R + B`, RB)); console.log(row(`${c.l} R`, R)); console.log(row(`${c.l} B`, B));
    const S = dayStats(RB), SR = dayStats(R), SB = dayStats(B);
    const pass = RB.length >= 60 && S.perCtr > 0 && S.t >= 2.3 && SB.perCtr > 0 && (!R.length || SR.perCtr > 0);
    console.log(`  VERDICT ${c.l}: ${pass ? "PASS" : "FAIL"} (${cents(S.perCtr)} t ${tt(S.t)}, ${RB.length} trades; R ${R.length ? cents(SR.perCtr) : "no games"}; B ${cents(SB.perCtr)})`);
  }
  if (!chosen.length) console.log("  no league chose a rule on A: FAIL");
  console.log(`\nrequests: Kalshi ${kReq} (${kRefused} refused), ESPN ${eReq}; ${Math.round((Date.now() - t0) / 60000)} minutes. Upper bound: a print says someone traded there, not that 10 more were available.`);
  process.exit(0);
}

const cells = new Map();
const add = (label, t) => { if (!cells.has(label)) cells.set(label, []); cells.get(label).push(t); };
const BANDS = [[0.75, 0.97], [0.55, 0.75], [0.75, 0.85], [0.85, 0.97]];
let done = 0, noPrint = 0;
const tS = Date.now();
for (const g of games) {
  if (++done % 200 === 0) console.error(`  scored ${done}/${games.length} games, ${kReq} Kalshi requests, ${Math.round((Date.now() - tS) / 60000)} min`);
  if (g.half) {
    const from = g.half.end + DELAY, tr = await gameTrades(g, from, from + LOOK);
    for (const [lo, hi] of BANDS) {
      const x = lateEntry(tr, from, { lookMs: LOOK, lo, hi });
      if (x) add(`half|${lo}-${hi}`, trade(g, x));
      else if (lo === 0.75 && hi === 0.97 && g.win !== "R") noPrint++;
    }
  }
  if (ONLY_PRIMARY) continue;
  if (g.other) {
    const from = g.other.end + DELAY, x = lateEntry(await gameTrades(g, from, from + LOOK), from, { lookMs: LOOK });
    if (x) add("other", trade(g, x));
  }
  if (g.first) {
    const from = g.first - PRE, x = lateEntry(await gameTrades(g, from, g.first), from, { lookMs: PRE });
    if (x) add("pre", trade(g, x));
  }
}

const prim = cells.get("half|0.75-0.97") || [];
const AB = prim.filter(x => x.win !== "R"), A = prim.filter(x => x.win === "A"), Bw = prim.filter(x => x.win === "B");
const HEAD = "                                        trades    won   paid  per ctr       t        days      at 10 contracts";
console.log(`\nTHE PRIMARY CELL: halftime (NHL: 2nd intermission), last play of the period +60s, first taker print within 5 min buying a side at 75-97c, ${SIZE} contracts, taker fee, held to settlement`);
console.log(HEAD);
console.log(row("A + B (scored)", AB));
console.log(row("A  2025-10-01..2026-02-28", A));
console.log(row("B  2026-09-01..2026-11-17", Bw));
console.log(`  (games with a halftime in A + B and no in-band print within 5 min: ${noPrint})`);
const S = dayStats(AB), SA = dayStats(A), SB = dayStats(Bw);
const pass = S.perCtr > 0 && S.t >= 2.5 && SA.perCtr > 0 && SB.perCtr > 0 && AB.length >= 200;
console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL"}  (needs per ctr > 0 at t >= 2.5 pooled, positive in A and in B, 200+ trades: ${cents(S.perCtr)} t ${tt(S.t)}; A ${cents(SA.perCtr)}; B ${cents(SB.perCtr)}; ${AB.length} trades)`);
if (AB.length) {
  const byDay = new Map(); for (const x of AB) byDay.set(x.day, (byDay.get(x.day) || 0) + x.pnl);
  let streak = 0, worst = 0; for (const x of [...AB].sort((a, b) => a.day.localeCompare(b.day))) { streak = x.won ? 0 : streak + 1; worst = Math.max(worst, streak); }
  console.log(`  worst day $${Math.min(...byDay.values()).toFixed(2)} at 10 contracts; longest losing run ${worst} trades`);
}
console.log("\nREFERENCE ONLY (never a second chance; a row that passes alone is a candidate for a fresh test on games after 2026-11-17)");
console.log(HEAD);
for (const l of LEAGUE_LIST) console.log(row(`halftime, league ${l}, A + B`, AB.filter(x => x.league === l)));
for (const b of ["0.55-0.75", "0.75-0.85", "0.85-0.97"]) console.log(row(`halftime, ${b.replace(/0\.(\d\d)/g, "$1")}c, A + B`, (cells.get(`half|${b}`) || []).filter(x => x.win !== "R")));
console.log(row("halftime rule in R", prim.filter(x => x.win === "R")));
if (!ONLY_PRIMARY) {
  console.log(row("pre-game (10 min before), A + B", (cells.get("pre") || []).filter(x => x.win !== "R")));
  console.log(row("end of 3rd qtr / NHL 1st int., A + B", (cells.get("other") || []).filter(x => x.win !== "R")));
}
console.log(`\nrequests: Kalshi ${kReq} (${kRefused} refused), ESPN ${eReq}; ${Math.round((Date.now() - t0) / 60000)} minutes. Upper bound: a print says someone traded there, not that 10 more were available.`);
