// A posted KXBTC15M rule with a three-market cooldown (docs/research/cooldown-plan.md).
//   node scripts/m15-cooldown.mjs --plumbing             data checks only, no price-to-result read
//   node scripts/m15-cooldown.mjs --score [--primary-only]
// Public reads only: Kalshi market data and trades, Coinbase one-minute
// candles. Cached under .cooldown-cache/ (gitignored), never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseTrade } from "../lib/m15Tape.js";
import { kalshiTakerFee } from "../lib/fees.js";
import { dayStats } from "../lib/m15Index.js";

const has = f => process.argv.includes(`--${f}`);
const SCORE = has("score"), PRIMARY_ONLY = has("primary-only");
if (!SCORE && !has("plumbing")) { console.error("pass --plumbing or --score"); process.exit(2); }
const KB = "https://api.elections.kalshi.com/trade-api/v2", CB = "https://api.exchange.coinbase.com";
const CACHE = ".cooldown-cache", MIN = 60000, SIZE = 5;   // the published rule buys 5
const SINCE = Date.parse("2026-09-01T00:00:00Z"), UNTIL = Date.parse("2026-11-28T00:00:00Z");
// amended plan: the primary is the months the published variants never saw; their own month is reference
const P_FROM = SINCE, P_TO = Date.parse("2026-10-29T00:00:00Z"), HALF = Date.parse("2026-09-30T00:00:00Z"), THEIRS = [P_TO, UNTIL];
const MINUTES = [10, 11, 12, 13, 14];   // checks 5, 4, 3, 2 and 1 minute before expiry
for (const d of ["trades"]) mkdirSync(join(CACHE, d), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let kReq = 0, kRefused = 0, cReq = 0, nextAt = 0;
async function kget(path) {
  for (let i = 0; i < 8; i++) {
    const wait = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + 200;
    await sleep(wait); kReq++;
    let r;
    try { r = await fetch(KB + path); } catch { await sleep(1000 * 2 ** i); continue; }
    if (r.status === 429 || r.status >= 500) { kRefused++; const ra = Number(r.headers.get("retry-after")); await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path.slice(0, 100)} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`GET ${path.slice(0, 100)}: still refused after 8 tries`);
}
const cached = f => existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const save = (f, v) => { writeFileSync(f + ".tmp", JSON.stringify(v)); renameSync(f + ".tmp", f); };

// ---- Kalshi: settled windows with their strikes ----
const cutoff = await kget("/historical/cutoff");
const marketCut = Date.parse(cutoff.market_settled_ts), tradeCut = Date.parse(cutoff.trades_created_ts);
async function windows() {
  const f = join(CACHE, "markets.json"), c = cached(f);
  if (c) return c;
  const out = new Map(), keep = m => {
    const close = Date.parse(m.close_time), open = Date.parse(m.open_time);
    if (close >= SINCE && close < UNTIL && (m.result === "yes" || m.result === "no") && Number.isFinite(Number(m.floor_strike)))
      out.set(m.ticker, { ticker: m.ticker, open, close, result: m.result, strike: Number(m.floor_strike) });
    return close;
  };
  let cursor = "";
  do {
    const d = await kget(`/markets?series_ticker=KXBTC15M&status=settled&min_close_ts=${Math.floor(Math.max(SINCE, marketCut - 86400000) / 1000)}&max_close_ts=${Math.floor(UNTIL / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    (d?.markets || []).forEach(keep); cursor = d?.cursor || "";
  } while (cursor);
  let oldest = Infinity; cursor = "";
  do {
    const d = await kget(`/historical/markets?series_ticker=KXBTC15M&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const m of d?.markets || []) oldest = Math.min(oldest, keep(m));
    cursor = d?.cursor || "";
  } while (cursor && oldest >= SINCE);
  const list = [...out.values()].sort((a, b) => a.close - b.close);
  save(f, list); return list;
}

// ---- Coinbase: one-minute closes, keyed by the minute's END (ms) ----
async function minuteCloses() {
  const f = join(CACHE, "btc-1m.json"), c = cached(f);
  if (c) return c;
  const out = {};
  for (let t = SINCE - 15 * MIN; t < UNTIL; t += 300 * MIN) {
    const s = new Date(t).toISOString(), e = new Date(Math.min(t + 300 * MIN, UNTIL)).toISOString();
    let d = null;
    for (let i = 0; i < 6 && d === null; i++) {
      cReq++; await sleep(150);
      try { const r = await fetch(`${CB}/products/BTC-USD/candles?granularity=60&start=${s}&end=${e}`); if (r.ok) d = await r.json(); else await sleep(1500 * 2 ** i); } catch { await sleep(1500 * 2 ** i); }
    }
    if (d === null) throw new Error(`Coinbase candles ${s}: failed`);
    for (const [ts, , , , close] of d) out[ts * 1000 + MIN] = close;
  }
  save(f, out); return out;
}

const W = await windows(), PX = await minuteCloses();
console.log(`KXBTC15M COOLDOWN RULE: ${SCORE ? "SCORE" : "PLUMBING"}; windows closing ${new Date(SINCE).toISOString().slice(0, 10)}..${new Date(UNTIL - 1).toISOString().slice(0, 10)}`);
const expected = Math.round((UNTIL - SINCE) / (15 * MIN));
let gaps = 0; for (let i = 1; i < W.length; i++) if (W[i].close - W[i - 1].close !== 15 * MIN) gaps++;
const minutesWanted = W.length * MINUTES.length, minutesHave = W.reduce((a, w) => { let n = 0; for (const k of MINUTES) if (PX[w.open + k * MIN] && PX[w.open + (k - 5) * MIN]) n++; return a + n; }, 0);
const strikeVsCb = W.map(w => PX[w.open] ? Math.abs(PX[w.open] - w.strike) : null).filter(x => x !== null).sort((a, b) => a - b);
const q = f => strikeVsCb[Math.floor(f * (strikeVsCb.length - 1))].toFixed(2);
console.log(`  settled windows ${W.length} of ${expected} expected; breaks in the 15-minute sequence ${gaps}`);
console.log(`  Coinbase minute closes present for ${(100 * minutesHave / minutesWanted).toFixed(2)}% of decision minutes (needs 98%)`);
console.log(`  |Coinbase at the open - Kalshi's strike| p50 $${q(0.5)}, p90 $${q(0.9)}, p99 $${q(0.99)} (the strike is BRTI's 60s average; Coinbase is a stand-in)`);
const ok = W.length >= 0.95 * expected && minutesHave >= 0.98 * minutesWanted;
console.log(ok ? "PLUMBING: clears" : "PLUMBING FAILS");
if (!SCORE) { console.log(`requests: Kalshi ${kReq}, Coinbase ${cReq}`); process.exit(0); }
if (!ok) process.exit(1);

// ---- the rule ----
async function tradesIn(w, from, to) {
  const f = join(CACHE, "trades", `${w.ticker}-${from}.json`), c = cached(f);
  if (c) return c;
  const base = w.close <= tradeCut ? "/historical/trades" : "/markets/trades";
  const out = []; let cursor = "";
  do {
    const d = await kget(`${base}?ticker=${w.ticker}&min_ts=${Math.floor(from / 1000)}&max_ts=${Math.ceil(to / 1000)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    for (const raw of d?.trades || []) { const x = parseTrade(raw); if (x && x.t >= from && x.t < to) out.push([x.t, x.side, x.price]); }
    cursor = d?.cursor || "";
    if (!(d?.trades || []).length) cursor = "";
  } while (cursor);
  save(f, out); return out;
}
const fee = p => kalshiTakerFee(p, SIZE, 1);
async function entryFor(w, { dist = 22, move = 0.0002, lo = 0.32, hi = 0.80, firstOnly = false }) {
  for (const k of MINUTES) {
    const t = w.open + k * MIN, p = PX[t], p5 = PX[t - 5 * MIN];
    if (!p || !p5) continue;
    const mv = p / p5 - 1;
    const side = p >= w.strike + dist && mv >= move ? "yes" : (p <= w.strike - dist && mv <= -move ? "no" : null);
    if (!side) continue;
    const tr = await tradesIn(w, t + 2000, t + 62000);
    const x = tr.find(([, s, pr]) => s === side && pr >= lo - 1e-9 && pr <= hi + 1e-9);
    if (x) { const won = side === w.result, pr = x[2]; return { side, price: pr, won, minute: k, pnl: (won ? (1 - pr) * SIZE : -pr * SIZE) - fee(pr) }; }
    if (firstOnly) return null;
  }
  return null;
}
async function simulate(opts, cooldown = 3, from = P_FROM, to = P_TO) {
  const traded = [], skipped = []; let skipTill = -Infinity;
  for (const w of W) {
    if (w.close < from || w.close >= to) continue;
    const e = await entryFor(w, opts);
    if (!e) continue;
    const row = { ...e, day: new Date(w.close).toISOString().slice(0, 10), half: w.close < HALF ? 1 : 2, ctrs: SIZE };
    if (w.open < skipTill) { skipped.push(row); continue; }
    traded.push(row);
    if (cooldown && row.pnl < 0) skipTill = w.close + cooldown * 15 * MIN;
  }
  return { traded, skipped };
}
const cents = v => `${v >= 0 ? "+" : ""}${(100 * v).toFixed(2)}c`, tt = t => Number.isFinite(t) ? t.toFixed(2) : "—";
function row(label, ts) {
  if (!ts.length) return `  ${label.padEnd(36)}      0`;
  const S = dayStats(ts), won = ts.filter(x => x.won).length / ts.length, paid = ts.reduce((a, x) => a + x.price, 0) / ts.length;
  return `  ${label.padEnd(36)} ${String(ts.length).padStart(6)}  ${(100 * won).toFixed(1).padStart(5)}%  ${paid.toFixed(3)}  ${cents(S.perCtr).padStart(8)}  t ${tt(S.t).padStart(6)}  days ${String(S.days).padStart(3)}  $${(S.pnl / Math.max(S.days, 1)).toFixed(2).padStart(6)}/day`;
}
const HEAD = "                                       trades    won   paid  per ctr        t       days    at 10 contracts";
const t0 = Date.now();
const P = await simulate({});
console.error(`  primary done: ${kReq} Kalshi requests, ${Math.round((Date.now() - t0) / 60000)} min`);
const T = P.traded, S1 = T.filter(x => x.half === 1), S2 = T.filter(x => x.half === 2);
console.log(`\nTHE PRIMARY (amended plan): last 5 minutes, checks at each minute close, Coinbase $22+ past the strike and a 0.02%+ 5-minute move the same way, first print 32-80c within 60s, 5 contracts, held; 3-window cooldown after a loss; windows closing 2026-09-01..2026-10-28 (the months their variants never saw)`);
console.log(HEAD);
console.log(row("rule with cooldown", T)); console.log(row("  first half (to 2026-09-29)", S1)); console.log(row("  second half (2026-09-30..10-28)", S2));
const st = dayStats(T), s1 = dayStats(S1), s2 = dayStats(S2);
const pass = T.length >= 200 && st.perCtr > 0 && st.t >= 2 && s1.perCtr > 0 && s2.perCtr > 0;
console.log(`VERDICT (rule): ${pass ? "PASS" : "FAIL"}  (${cents(st.perCtr)} t ${tt(st.t)}; halves ${cents(s1.perCtr)} / ${cents(s2.perCtr)}; ${T.length} trades)`);
let cum = 0, killed = null; for (const x of T) { cum += x.pnl; if (cum <= -25 && !killed) killed = x.day; }
console.log(`  the $25 kill switch: ${killed ? `would have halted the run on ${killed}` : "would not have fired"} (total ${cum >= 0 ? "+" : "-"}$${Math.abs(cum).toFixed(2)} at 5 contracts)`);
const K = P.skipped, K1 = K.filter(x => x.half === 1), K2 = K.filter(x => x.half === 2);
console.log("\nTHE COOLDOWN (a skip rule): what it removed in the primary period");
console.log(HEAD);
console.log(row("skipped by the cooldown", K)); console.log(row("  skipped, first half", K1)); console.log(row("  skipped, second half", K2));
const sk = dayStats(K), k1 = dayStats(K1), k2 = dayStats(K2);
const keep = K.length > 0 && sk.t <= -1 && k1.perCtr < s1.perCtr && k2.perCtr < s2.perCtr;
console.log(`VERDICT (cooldown): ${keep ? "KEEP" : "DROP"}  (skipped ${cents(sk.perCtr)} t ${tt(sk.t)}; needs t <= -1 and worse than traded in both halves: ${cents(k1.perCtr)} vs ${cents(s1.perCtr)}, ${cents(k2.perCtr)} vs ${cents(s2.perCtr)})`);
if (!PRIMARY_ONLY) {
  console.log("\nREFERENCE ONLY (never a second chance)");
  console.log(HEAD);
  const theirs = await simulate({}, 3, THEIRS[0], THEIRS[1]);
  console.log(row("THEIR month 10-29..11-27 (in-sample)", theirs.traded));
  console.log(row("no cooldown", (await simulate({}, 0)).traded));
  for (const [lo, hi] of [[0.05, 0.95], [0.32, 0.95], [0.35, 0.95], [0.05, 0.78], [0.05, 0.80]]) {
    console.log(row(`band ${Math.round(lo * 100)}-${Math.round(hi * 100)}c`, (await simulate({ lo, hi })).traded));
    console.log(row(`  same band, their month`, (await simulate({ lo, hi }, 3, THEIRS[0], THEIRS[1])).traded));
  }
  for (const dist of [0, 44]) console.log(row(`distance $${dist}`, (await simulate({ dist })).traded));
  for (const move of [0.0001, 0.0004]) console.log(row(`move ${(move * 100).toFixed(2)}%`, (await simulate({ move })).traded));
  console.log(row("first qualifying minute only", (await simulate({ firstOnly: true })).traded));
  const byMin = {}; for (const x of T) (byMin[x.minute] ||= []).push(x);
  for (const [m, v] of Object.entries(byMin)) console.log(row(`  entered ${15 - Number(m)} min before expiry`, v));
}
console.log(`\nrequests: Kalshi ${kReq} (${kRefused} refused), Coinbase ${cReq}; ${Math.round((Date.now() - t0) / 60000)} min. Upper bound: a print is one trade; Coinbase stands in for BRTI.`);
