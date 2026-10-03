// The spread comparison at full resolution, in each window's final two
// minutes. lib/venueCompare.js samples Kalshi once a second, which is all
// its record holds for most of a window, so it cannot say what happens to
// an edge 50 or 250 ms after it appears. In the final two minutes the
// Kalshi recorder keeps EVERY book change ("full" + "d" lines, on
// Kalshi's own clock), and the .us recorder keeps every book all window.
// Replaying both gives the books at any instant, to the millisecond.
//
// WHAT A BOT WOULD DO, modelled:
//   - It acts at the FIRST moment an edge exists (the event that created
//     it), not at the episode's best moment, which only hindsight knows.
//   - Both legs go out at once as limit orders at the prices that size
//     walked to, IOC-style, and arrive DELAY ms after that event. Each
//     fills whatever is resting at or better than its limit at arrival.
//   - Both legs filled is the edge; one filled alone is a naked position.
//
// DELAY is measured from the exchange timestamp of the change that made
// the edge, so it must cover everything: the venue publishing it, the
// socket to the bot, deciding, and both orders reaching both venues.
//
// WHAT IT CANNOT SEE: our own orders do not move these books, and other
// traders' reactions to them are not modelled. The two venues' clocks
// are each their own; a skew of a few ms between them is invisible here
// and matters at the shortest delays.
//
// A window is only replayed if nothing interrupted the Kalshi record in
// its final two minutes: a sequence gap or a socket event means the book
// between that moment and the next full snapshot is not known, and a
// stale book manufactures edges.

import { bestFill, KALSHI_SERIES, MAX_AGE_MS } from "./venueCompare.js";

export const FINAL_DELAYS_MS = [50, 100, 250, 500, 1000];
const K = p => Math.round(p * 10000);
const mirror = L => L.map(([p, q]) => [Math.round((1 - p) * 10000) / 10000, q]);

export function newFinal() {
  return { win: new Map(), conn: [], gaps: [], lines: 0 };
}

function winOf(F, m) {
  if (!F.win.has(m)) F.win.set(m, { finalT: null, close: null, events: [] });
  return F.win.get(m);
}

// One parsed line of the Kalshi archive. Keeps only what the final-window
// replay needs; everything else is ignored.
export function feedKalshiFinal(F, o) {
  if (!o) return;
  if (o.k === "conn") { F.conn.push(o.t); return; }
  if (o.k === "gap") {
    const ms = (Array.isArray(o.m) ? o.m : [o.m]).filter(m => typeof m === "string" && m.startsWith(KALSHI_SERIES + "-"));
    if (ms.length) F.gaps.push({ t: o.t, m: ms });
    return;
  }
  if (typeof o.m !== "string" || !o.m.startsWith(KALSHI_SERIES + "-")) return;
  if (o.k === "final") {
    const w = winOf(F, o.m);
    w.finalT = o.t; w.close = Date.parse(o.close);
  } else if (o.k === "full") {
    winOf(F, o.m).events.push({ f: 1, x: Number.isFinite(o.x) ? o.x : null, L: o.L || [[], []] }); F.lines++;
  } else if (o.k === "d") {
    winOf(F, o.m).events.push({ f: 0, x: Number.isFinite(o.x) ? o.x : null, sd: o.sd, p: o.p, q: o.q }); F.lines++;
  }
}

function latestAtOrBefore(arr, t) {
  let lo = 0, hi = arr.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}
function limitAt(L, n) { let acc = 0; for (const [p, q] of L) { acc += q; if (acc >= n) return p; } return null; }

// Replays every undisturbed final window. C is the venueCompare state the
// .us archive was fed into (its books and its slug map).
export function finalReplay(C, F, delays = FINAL_DELAYS_MS) {
  const out = {
    windows: 0, kalshiEvents: 0, evaluations: 0, selfCrossed: 0, staleUs: 0,
    excluded: { noFinal: 0, noUs: 0, disrupted: 0 },
    episodes: [],
  };
  for (const [ticker, w] of F.win) {
    if (!w.close || !w.finalT || !w.events.length) { out.excluded.noFinal++; continue; }
    const slug = C.slugOf.get(ticker), ps = slug && C.pmus.get(slug);
    if (!ps || !ps.length) { out.excluded.noUs++; continue; }
    // Box-clock checks: the recorder's own interruptions, from the moment
    // it marked the window final until just past the close.
    const lo = w.finalT - 1000, hi = w.close + 2000;
    if (F.conn.some(t => t >= lo && t <= hi) || F.gaps.some(g => g.t >= lo && g.t <= hi && g.m.includes(ticker))) { out.excluded.disrupted++; continue; }
    ps.sort((a, b) => a.t - b.t);
    out.windows++;
    replayWindow(ticker, slug, w, ps, delays, out);
  }
  return out;
}

function replayWindow(ticker, slug, w, ps, delays, out) {
  const close = w.close;
  const bids = new Map(), asks = new Map();
  let ready = false, lastX = null;
  // Kalshi events in record order (the socket's sequence order); a missing
  // exchange time inherits the last one seen, and time never runs back.
  const kev = [];
  for (const e of w.events) {
    let x = e.x ?? lastX ?? w.finalT;
    if (lastX != null && x < lastX) x = lastX;
    lastX = x;
    kev.push({ ...e, t: x });
  }
  let pi = latestAtOrBefore(ps, kev[0].t);
  let pCur = pi >= 0 ? ps[pi] : null;
  pi = pi < 0 ? 0 : pi + 1;
  let ki = 0;
  const open = { A: null, B: null };
  const pending = [];

  const touch = () => {
    let b = null, a = null;
    for (const k of bids.keys()) if (b == null || k > b) b = k;
    for (const k of asks.keys()) if (a == null || k < a) a = k;
    return { kb: b == null ? null : b / 10000, ka: a == null ? null : a / 10000 };
  };
  const usFresh = t => pCur && t - pCur.t <= MAX_AGE_MS;

  // The two legs of a direction, cut to the levels that could ever pay:
  // past the other venue's best price a pair costs $1 or more.
  function legs(dir, kb, ka) {
    if (dir === "A") {
      const pb = pCur.b[0]?.[0];
      if (ka == null || pb == null || !(ka < pb - 1e-9)) return null;
      const KL = [...asks].filter(([k]) => k / 10000 < pb - 1e-9).map(([k, q]) => [k / 10000, q]).sort((x, y) => x[0] - y[0]);
      const PL = mirror(pCur.b.filter(([p]) => p > ka + 1e-9));
      return [KL, PL];
    }
    const pa = pCur.a[0]?.[0];
    if (kb == null || pa == null || !(pa < kb - 1e-9)) return null;
    const KL = mirror([...bids].filter(([k]) => k / 10000 > pa + 1e-9).map(([k, q]) => [k / 10000, q]).sort((x, y) => y[0] - x[0]));
    const PL = pCur.a.filter(([p]) => p < kb - 1e-9);
    return [KL, PL];
  }

  function closeEp(d, t) {
    const e = open[d];
    if (!e) return;
    e.end = t;
    out.episodes.push(e);
    open[d] = null;
  }

  function evaluate(t) {
    if (!ready || t >= close) return;
    if (!usFresh(t)) { out.staleUs++; closeEp("A", t); closeEp("B", t); return; }
    const { kb, ka } = touch();
    if (kb != null && ka != null && kb >= ka) { out.selfCrossed++; closeEp("A", t); closeEp("B", t); return; }
    out.evaluations++;
    for (const d of ["A", "B"]) {
      const L = legs(d, kb, ka);
      const f = L && bestFill(L[0], L[1]);
      if (!(f && f.profit > 0)) { closeEp(d, t); continue; }
      if (open[d]) { open[d].last = t; if (f.profit > open[d].bestProfit) open[d].bestProfit = f.profit; continue; }
      const e = { dir: d, ticker, slug, start: t, last: t, end: null, ttc: (close - t) / 1000,
        size: f.size, profit: f.profit, bestProfit: f.profit, touchEdge: f.touchEdge,
        limK: limitAt(L[0], f.size), limP: limitAt(L[1], f.size), after: {} };
      open[d] = e;
      for (const dl of delays) pending.push({ at: t + dl, e, dl });
    }
  }

  // What each leg's limit order finds when it arrives: the books as they
  // stand after every change up to and including that instant.
  function check(c) {
    const { e, dl, at } = c;
    if (at >= close || !usFresh(at)) { e.after[dl] = null; return; }
    let availK = 0, availP = 0;
    if (e.dir === "A") {
      for (const [k, q] of asks) if (k / 10000 <= e.limK + 1e-9) availK += q;
      for (const [p, q] of pCur.b) if (1 - p <= e.limP + 1e-9) availP += q;
    } else {
      for (const [k, q] of bids) if (1 - k / 10000 <= e.limK + 1e-9) availK += q;
      for (const [p, q] of pCur.a) if (p <= e.limP + 1e-9) availP += q;
    }
    const n = e.size, k = Math.min(n, availK), p = Math.min(n, availP), both = Math.min(k, p);
    e.after[dl] = { both, legged: Math.max(k, p) - both, dollars: n ? e.profit * both / n : 0 };
  }
  function runChecks(before) {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at < before) { check(pending[i]); pending.splice(i, 1); }
  }

  while (ki < kev.length || (pi < ps.length && ps[pi].t < close)) {
    const nextK = ki < kev.length ? kev[ki].t : Infinity;
    const nextP = pi < ps.length ? ps[pi].t : Infinity;
    const t = Math.min(nextK, nextP);
    if (t >= close) break;
    runChecks(t);
    if (nextK <= nextP) {
      const e = kev[ki++];
      out.kalshiEvents++;
      if (e.f) {
        bids.clear(); asks.clear();
        for (const [p, q] of e.L[0] || []) if (q > 0) bids.set(K(p), q);
        for (const [p, q] of e.L[1] || []) if (q > 0) asks.set(K(p), q);
        ready = true;
      } else if (ready) {
        const side = e.sd === "b" ? bids : asks, k = K(e.p);
        const n = Math.round(((side.get(k) || 0) + e.q) * 100) / 100;
        if (n > 0) side.set(k, n); else side.delete(k);
      }
    } else {
      pCur = ps[pi++];
    }
    evaluate(t);
  }
  runChecks(Infinity);
  const end = Math.min(close, lastX ?? close);
  closeEp("A", end); closeEp("B", end);
}

// Per delay: episodes filled in full, in part, not at all; how many left a
// leg filled on its own; dollars kept. Delays whose arrival fell after the
// close are not counted for that episode.
export function finalDelayStats(episodes, delays = FINAL_DELAYS_MS) {
  const out = {};
  for (const d of delays) {
    const r = { full: 0, partial: 0, none: 0, legged: 0, dollars: 0, known: 0 };
    for (const e of episodes) {
      const a = e.after?.[d];
      if (!a) continue;
      r.known++;
      if (a.both >= e.size) r.full++; else if (a.both > 0) r.partial++; else r.none++;
      if (a.legged > 0) r.legged++;
      r.dollars += a.dollars;
    }
    out[d] = r;
  }
  return out;
}

// How long edges last, in ms, and what they were worth at first sight
// against their best moment.
export function finalEpisodeStats(eps) {
  const d = eps.map(e => (e.end ?? e.last) - e.start).sort((a, b) => a - b);
  const q = f => d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : null;
  const under = ms => d.filter(x => x < ms).length;
  return {
    n: eps.length, medianMs: q(0.5), p90Ms: q(0.9), maxMs: d.length ? d[d.length - 1] : null,
    under: Object.fromEntries([50, 100, 250, 500, 1000].map(ms => [ms, under(ms)])),
    firstDollars: eps.reduce((s, e) => s + e.profit, 0),
    bestDollars: eps.reduce((s, e) => s + e.bestProfit, 0),
  };
}
