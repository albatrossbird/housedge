// Ladder step 2's scope check (docs/research/ladder-step2-plan.md), from the
// step 1 cache only (no new reads):
//   node scripts/ladder-scope.mjs
//
// Re-scores step 1 at the 100ms window, keeping only what the step 2
// recorder would record: at each hourly BTC close, the KXBTC15M window
// closing then plus the KXBTCD and KXBTC markets whose strike is within
// ±2.5% of that window's strike (capped at 80, nearest first), and only
// prints in the final 16 minutes. If the scope keeps under 80% of step 1's
// 100ms edge, the plan says widen it before recording.

import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { reviveEvent, contradictionCandidates, allocate, implicationPairs, seriesOfTicker } from "../lib/ladder.js";
import { kalshiTakerFee } from "../lib/fees.js";

const CACHE = ".ladder-cache", WINDOW = 100, LOOK = 16 * 60000, BAND = 0.025, CAP = 80, KEEP = 0.8;
const sp = JSON.parse(readFileSync(join(CACHE, "size-pass.json"), "utf8"));
for (const m of sp.markets) m.ev = reviveEvent(m.ev);
const fees = JSON.parse(readFileSync(join(CACHE, "fees.json"), "utf8"));
const fee = (p, n, t) => kalshiTakerFee(p, n, fees[seriesOfTicker(t)].multiplier, 0.0001);
const tapePath = t => join(CACHE, "tape", `${t}.json.gz`);
const load = t => existsSync(tapePath(t)) ? JSON.parse(gunzipSync(readFileSync(tapePath(t)))).map(([t, s, price, count]) => ({ t, side: s ? "yes" : "no", price, count })) : [];

const groups = new Map();
for (const m of sp.markets) { if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }

const strikeOf = ev => Number.isFinite(ev.lo) && Number.isFinite(ev.hi) ? (ev.lo + ev.hi) / 2 : Number.isFinite(ev.lo) ? ev.lo : ev.hi;
let full = 0, scoped = 0, fullBtc = 0, groupsScoped = 0, maxMembers = 0;
const missing15m = [];
for (const [g, ms] of groups) {
  const traded = ms.filter(m => m.volume > 0);
  if (traded.length < 2 || !implicationPairs(traded).length) continue;
  const tapes = new Map(traded.map(m => [m.ticker, load(m.ticker)]));
  const all = allocate(contradictionCandidates(traded.map(m => ({ ticker: m.ticker, ev: m.ev })), tapes, { maxWindowMs: WINDOW, fee }), { windowMs: WINDOW, fee });
  const e = all.reduce((s, a) => s + a.edge, 0);
  full += e;
  if (!g.startsWith("BRTI|")) continue;
  fullBtc += e;
  const close = ms[0].close;
  if (new Date(close).getUTCMinutes() !== 0) continue; // the recorder covers hourly closes only
  const w15 = ms.find(m => m.series === "KXBTC15M");
  if (!w15 || w15.floor == null) { missing15m.push(g); continue; }
  const ref = Number(w15.floor);
  const ladder = traded.filter(m => (m.series === "KXBTCD" || m.series === "KXBTC") && Math.abs(strikeOf(m.ev) / ref - 1) <= BAND)
    .sort((a, b) => Math.abs(strikeOf(a.ev) - ref) - Math.abs(strikeOf(b.ev) - ref)).slice(0, CAP - 1);
  const members = [...(w15.volume > 0 ? [w15] : []), ...ladder];
  maxMembers = Math.max(maxMembers, members.length);
  const late = new Map(members.map(m => [m.ticker, tapes.get(m.ticker).filter(p => p.t >= close - LOOK)]));
  const sc = allocate(contradictionCandidates(members.map(m => ({ ticker: m.ticker, ev: m.ev })), late, { maxWindowMs: WINDOW, fee }), { windowMs: WINDOW, fee });
  scoped += sc.reduce((s, a) => s + a.edge, 0);
  groupsScoped++;
}
const share = full ? scoped / full : 0;
console.log(`step 1 at ${WINDOW}ms: $${full.toFixed(2)} in all; Bitcoin (BRTI) $${fullBtc.toFixed(2)}`);
console.log(`in the step 2 scope (hourly BTC closes, KXBTC15M + KXBTCD/KXBTC within ±${BAND * 100}%, cap ${CAP}, final 16 min): $${scoped.toFixed(2)} over ${groupsScoped} closes, at most ${maxMembers} markets at one close`);
console.log(`kept: ${(100 * share).toFixed(1)}% of all, ${(100 * (fullBtc ? scoped / fullBtc : 0)).toFixed(1)}% of Bitcoin's`);
if (missing15m.length) console.log(`hourly closes with no KXBTC15M strike, left out: ${missing15m.length}`);
console.log(`verdict: ${share >= KEEP ? "scope stands" : `WIDEN (under ${KEEP * 100}% kept)`}`);
