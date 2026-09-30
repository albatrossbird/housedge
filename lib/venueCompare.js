// Kalshi's KXBTC15M against Polymarket US's "BTC Up or Down: 15 min",
// read back from the two WebSocket archives. Pure: fed one parsed NDJSON
// line at a time, then reduced by summarize(). scripts/pmus15-compare.mjs
// fetches; scripts/venue-compare.test.mjs drives this with built lines.
//
// SAME CLAIM (lib/pmus15.js has the evidence), so Up is YES and a pair of
// opposite sides bought across the two venues pays exactly $1. The
// question this answers is whether the two books ever sit far enough
// apart, for long enough and deep enough, to pay for BOTH venues' taker
// fees. Two directions:
//
//   A  buy YES on Kalshi at its ask   + buy DOWN on .us at 1 - Up bid
//   B  buy UP  on .us at its ask      + buy NO on Kalshi at 1 - YES bid
//
// THE SAMPLING IS THE KALSHI SNAPSHOT. The Kalshi recorder writes a book
// once a second when it changed (10s heartbeat otherwise); the .us one
// writes every whole book it receives, several a second. So each sample
// is a moment Kalshi was freshly read, paired with the .us book current
// at that moment. Sampling on .us changes instead would pair a fresh .us
// book with a Kalshi book up to a second old, and on a market whose touch
// moves dozens of times a second that manufactures crosses that never
// existed.
//
// WHAT THIS CANNOT SAY. Both legs are priced as if filled at the same
// instant, by a taker, at the recorded depth. Nobody fills two venues at
// once: an edge that lasts one sample is an upper bound, not a trade.
// That is why episodes report their DURATION, and why the per-episode
// dollars take the best single moment rather than summing samples.
//
// Kalshi depth is its top 10 levels a side (all the 1-second record
// keeps); .us depth is the whole book.

import { kalshiTakerFee } from "./fees.js";
import { parsePmusSlug } from "./pmus15.js";

export const KALSHI_SERIES = "KXBTC15M";
export const KALSHI_FEE_MULT = 1;        // /series/KXBTC15M fee_multiplier, checked 2026-09-28
export const PMUS_FEE_COEF = 0.0695;     // docs.polymarket.us/fees and the market's feeCoefficient
export const MAX_AGE_MS = 15000;         // both recorders heartbeat every 10s
const EPISODE_JOIN_MS = 2500;            // samples closer than this belong to one episode

// Polymarket US rounds each fee to the cent, round-half-even (its fee page).
function roundHalfEven(x) {
  const c = x * 100, f = Math.floor(c), d = c - f;
  const r = d > 0.5 + 1e-9 ? f + 1 : d < 0.5 - 1e-9 ? f : (f % 2 === 0 ? f : f + 1);
  return r / 100;
}
export function pmusTakerFee(price, qty) {
  const p = Number(price);
  if (!(p > 0 && p < 1) || !(qty > 0)) return 0;
  return roundHalfEven(PMUS_FEE_COEF * qty * p * (1 - p));
}

// The two legs of one direction, each as [price, qty] best-first ladders
// of what we BUY. Walks both at once and returns the size that makes the
// most money, fees included and rounded as each venue rounds them (one
// order per venue). Between level boundaries the marginal cost is
// constant, so the optimum is at a boundary; every boundary is checked.
export function bestFill(kalshiLadder, pmusLadder) {
  const K = kalshiLadder.filter(([p, q]) => p > 0 && p < 1 && q > 0);
  const P = pmusLadder.filter(([p, q]) => p > 0 && p < 1 && q > 0);
  if (!K.length || !P.length) return null;
  const cost = (L, n) => { let c = 0, left = n; for (const [p, q] of L) { const t = Math.min(q, left); c += t * p; left -= t; if (left <= 0) break; } return c; };
  // Fee on a sweep: each level's fills priced at that level. Kalshi rounds
  // the ORDER's fee up to the cent; .us rounds each fill half-even.
  const feeK = n => { let raw = 0, left = n; for (const [p, q] of K) { const t = Math.min(q, left); raw += t * 0.07 * KALSHI_FEE_MULT * p * (1 - p); left -= t; if (left <= 0) break; } return Math.ceil(raw * 100 - 1e-9) / 100; };
  const feeP = n => { let f = 0, left = n; for (const [p, q] of P) { const t = Math.min(q, left); f += pmusTakerFee(p, t); left -= t; if (left <= 0) break; } return f; };
  const capK = K.reduce((s, [, q]) => s + q, 0), capP = P.reduce((s, [, q]) => s + q, 0);
  const cap = Math.min(capK, capP);
  const bounds = new Set([1]);
  let acc = 0; for (const [, q] of K) { acc += q; if (acc <= cap) bounds.add(acc); }
  acc = 0; for (const [, q] of P) { acc += q; if (acc <= cap) bounds.add(acc); }
  bounds.add(cap);
  let best = null;
  for (const n of [...bounds].filter(n => n >= 1).sort((a, b) => a - b)) {
    const profit = n - cost(K, n) - cost(P, n) - feeK(n) - feeP(n);
    if (!best || profit > best.profit) best = { size: n, profit };
  }
  // The edge at the touch, per contract, fees at a 100-lot so Kalshi's
  // cent rounding is not charged in full against one contract.
  const k0 = K[0][0], p0 = P[0][0];
  const touchEdge = 1 - k0 - p0 - kalshiTakerFee(k0, 100, KALSHI_FEE_MULT) / 100 - PMUS_FEE_COEF * p0 * (1 - p0);
  return { ...best, touchEdge, gross: 1 - k0 - p0 };
}

// The Kalshi 1-second record: L = [bids, asks], YES prices, best-first.
// Buying NO at 1 - bid is taking the YES bids.
const mirror = L => L.map(([p, q]) => [Math.round((1 - p) * 10000) / 10000, q]);

export function newCompare() {
  return {
    kalshi: new Map(),     // ticker -> [{ t, b, a, L }]
    pmus: new Map(),       // slug -> [{ t, b:[[p,q]], a:[[p,q]], x }]
    slugOf: new Map(),     // kalshi ticker -> .us slug (from the .us recorder's mkt lines)
    pmusConn: {}, pmusErrors: 0, pmusTrades: 0, pmusFirst: Infinity, pmusLast: -Infinity,
    kalshiFirst: Infinity, kalshiLast: -Infinity,
  };
}

export function feedKalshi(C, o) {
  if (!o || o.k !== "b" || typeof o.m !== "string" || !o.m.startsWith(KALSHI_SERIES + "-")) return;
  if (!C.kalshi.has(o.m)) C.kalshi.set(o.m, []);
  C.kalshi.get(o.m).push({ t: o.t, b: o.b, a: o.a, L: o.L || [[], []] });
  if (o.t < C.kalshiFirst) C.kalshiFirst = o.t;
  if (o.t > C.kalshiLast) C.kalshiLast = o.t;
}

export function feedPmus(C, o) {
  if (!o) return;
  if (o.k === "mkt" && o.kalshi) { C.slugOf.set(o.kalshi, o.m); return; }
  if (o.k === "conn") { C.pmusConn[o.ev] = (C.pmusConn[o.ev] || 0) + 1; return; }
  if (o.k === "err") { C.pmusErrors++; return; }
  if (o.k === "tr") { C.pmusTrades++; return; }
  if (o.k !== "pb") return;
  if (!C.pmus.has(o.m)) C.pmus.set(o.m, []);
  C.pmus.get(o.m).push({ t: o.t, b: o.b || [], a: o.a || [], x: o.x ?? null });
  if (o.t < C.pmusFirst) C.pmusFirst = o.t;
  if (o.t > C.pmusLast) C.pmusLast = o.t;
}

function latestAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}

const TTC_BUCKETS = [[600, Infinity, ">10m"], [300, 600, "5-10m"], [120, 300, "2-5m"], [60, 120, "1-2m"], [0, 60, "<1m"]];
const bucketOf = s => TTC_BUCKETS.find(([lo, hi]) => s >= lo && s < hi)?.[2] ?? null;

export function summarize(C) {
  const out = {
    windows: 0, samples: 0,
    // The mirror test is only decisive away from 50c: a book near 50c is
    // close to its own complement and matches both sides.
    agree: { exact: 0, within1c: 0, decisive: 0, decisiveWithin1c: 0, mirrorWithin1c: 0 },
    grossCross: 0,
    byDir: { A: { positive: 0 }, B: { positive: 0 } },
    byBucket: Object.fromEntries(TTC_BUCKETS.map(([, , k]) => [k, { samples: 0, positive: 0 }])),
    episodes: [],
    leadLag: null,
  };
  const series = [];   // for lead/lag: [t, kalshiMid, pmusMid]
  for (const [ticker, ks] of C.kalshi) {
    const slug = C.slugOf.get(ticker);
    const ps = slug && C.pmus.get(slug);
    if (!ps || !ps.length) continue;
    const close = parsePmusSlug(slug)?.close;
    if (!close) continue;
    ks.sort((x, y) => x.t - y.t); ps.sort((x, y) => x.t - y.t);
    out.windows++;
    const open = { A: null, B: null };
    const flush = d => { if (open[d]) { out.episodes.push(open[d]); open[d] = null; } };
    for (const k of ks) {
      if (k.t >= close) break;
      const i = latestAtOrBefore(ps, k.t);
      if (i < 0 || k.t - ps[i].t > MAX_AGE_MS) continue;
      const p = ps[i];
      if (k.b == null || k.a == null || !p.b.length || !p.a.length) continue;
      const pb = p.b[0][0], pa = p.a[0][0];
      out.samples++;
      series.push([k.t, (k.b + k.a) / 2, (pb + pa) / 2]);
      if (Math.abs(k.b - pb) < 5e-4 && Math.abs(k.a - pa) < 5e-4) out.agree.exact++;
      if (Math.abs(k.b - pb) <= 0.0105 && Math.abs(k.a - pa) <= 0.0105) out.agree.within1c++;
      if (Math.abs((k.b + k.a) / 2 - 0.5) > 0.05) {
        out.agree.decisive++;
        if (Math.abs(k.b - pb) <= 0.0105 && Math.abs(k.a - pa) <= 0.0105) out.agree.decisiveWithin1c++;
        if (Math.abs(k.b - (1 - pa)) <= 0.0105 && Math.abs(k.a - (1 - pb)) <= 0.0105) out.agree.mirrorWithin1c++;
      }
      if (pb > k.a + 1e-9 || k.b > pa + 1e-9) out.grossCross++;

      const ttc = (close - k.t) / 1000, bucket = bucketOf(ttc);
      if (bucket) out.byBucket[bucket].samples++;
      const [kBids, kAsks] = k.L;
      const dirs = {
        A: bestFill(kAsks, mirror(p.b)),          // YES on Kalshi + DOWN on .us
        B: bestFill(mirror(kBids), p.a),          // NO on Kalshi + UP on .us
      };
      let anyPos = false;
      for (const d of ["A", "B"]) {
        const f = dirs[d];
        if (!f || !(f.profit > 0)) {
          if (open[d] && k.t - open[d].last > EPISODE_JOIN_MS) flush(d);
          continue;
        }
        anyPos = true;
        out.byDir[d].positive++;
        if (open[d] && k.t - open[d].last > EPISODE_JOIN_MS) flush(d);
        if (!open[d]) open[d] = { dir: d, ticker, slug, start: k.t, last: k.t, samples: 0, ttcStart: ttc, bestProfit: 0, bestSize: 0, bestTouchEdge: -Infinity };
        const e = open[d];
        e.last = k.t; e.samples++;
        if (f.profit > e.bestProfit) { e.bestProfit = f.profit; e.bestSize = f.size; }
        if (f.touchEdge > e.bestTouchEdge) e.bestTouchEdge = f.touchEdge;
      }
      if (anyPos && bucket) out.byBucket[bucket].positive++;
    }
    flush("A"); flush("B");
  }
  out.leadLag = leadLag(series);
  return out;
}

// Which venue moves first. Changes in each mid on the sample grid,
// correlated at lags of -3..+3 samples (~seconds). A peak at a POSITIVE
// lag means .us follows Kalshi; negative means Kalshi follows .us.
// Samples from different windows are separated by gaps and so are joined
// only where consecutive samples are within 2.5s.
function leadLag(series) {
  if (series.length < 50) return null;
  series.sort((x, y) => x[0] - y[0]);
  const dk = [], dp = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i][0] - series[i - 1][0] > 2500) { dk.push(null); dp.push(null); continue; }
    dk.push(series[i][1] - series[i - 1][1]); dp.push(series[i][2] - series[i - 1][2]);
  }
  const corr = lag => {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < dk.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= dp.length || dk[i] == null || dp[j] == null) continue;
      const x = dk[i], y = dp[j];
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < 30) return null;
    const cov = sxy / n - (sx / n) * (sy / n), vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2;
    return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null;
  };
  const byLag = {};
  for (let lag = -3; lag <= 3; lag++) byLag[lag] = corr(lag);
  return byLag;
}

export const episodeStats = eps => {
  const d = eps.map(e => (e.last - e.start) / 1000 + 1).sort((a, b) => a - b);
  const q = f => d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : null;
  return { n: eps.length, medianS: q(0.5), p90S: q(0.9), maxS: d.length ? d[d.length - 1] : null,
    multiSample: eps.filter(e => e.samples >= 2).length, dollars: eps.reduce((s, e) => s + e.bestProfit, 0) };
};
