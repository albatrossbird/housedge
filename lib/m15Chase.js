// Ways a live taker could get MORE fills out of an entry rule, replayed on
// the archive's every-change record (lib/m15Maker.js) so each is priced on
// the book it would really have met:
//
//   base        one limit at the price seen, filled against the book DELAY
//               ms later — the per-change backtest's own assumption;
//   chase +Nc   the same order with its limit N cents above the price seen,
//               but never above the rule's price cap (a 97c decision is
//               not sent at 98c), paying what the book actually offers;
//   retry       after a miss, the rule is checked again from the moment the
//               reply came back, and the next qualifying moment is sent the
//               same way, until a fill or the rule's window ends.
//
// Every variant pays the WALKED price — the best offers up to its limit —
// so the rows compare like for like (the per-change table charges the
// price seen). A query at or after the close is a miss with no book read.
// One pass over the record serves every variant: each asks about strictly
// later instants than its last, so they are answered in time order.

import { findEntry } from "./m15Backtest.js";
import { bookCursor } from "./m15Maker.js";

export const CHASE_VARIANTS = [
  { key: "base", cents: 0, retry: false },
  { key: "chase+1c", cents: 1, retry: false },
  { key: "chase+2c", cents: 2, retry: false },
  { key: "retry", cents: 0, retry: true },
  { key: "retry+1c", cents: 1, retry: true },
];
export const CHASE_DELAYS_MS = [100, 250];

const r4 = x => Math.round(x * 10000) / 10000;

// Up to `qty` bought from `snap` at or below `limit`, best offers first.
// YES takes YES asks; NO takes YES bids mirrored. raw = the unrounded
// Kalshi fee factor sum, q x p(1-p), for the caller to price.
export function walkFill(snap, side, limit, qty) {
  const L = side === "yes" ? snap.asks : snap.bids.map(([p, q]) => [r4(1 - p), q]);
  let n = 0, cost = 0, pq = 0;
  for (const [p, q] of L) {
    if (p > limit + 1e-9 || n >= qty) break;
    const take = Math.min(q, qty - n);
    n += take; cost += take * p; pq += take * p * (1 - p);
  }
  n = Math.floor(n + 1e-9);
  return { n, cost: r4(cost), pq };
}

// strategies: [[name, strat]]. rows: the decision path (once-a-second or
// change-by-change rows, sorted). Returns { [name]: { [variant]: { [delay]:
// result } } }, result = null (never decided), { unknown } (a book that
// could not be read), or { tries, n, cost, pq, side, price }.
export function simulateChase(w, market, rows, strategies, { size = 1, requireDepth = true, variants = CHASE_VARIANTS, delays = CHASE_DELAYS_MS } = {}) {
  const out = {}, jobs = [];
  for (const [name, strat] of strategies) {
    out[name] = {};
    for (const v of variants) {
      out[name][v.key] = {};
      for (const delay of delays) {
        if (!(delay > 0)) throw new Error("chase delays must be positive");
        const job = { name, strat, v, delay, tries: 0, from: 0, d: null, q: null, firstSide: null };
        out[name][v.key][delay] = null;
        decide(job);
        if (job.d) jobs.push(job);
      }
    }
  }
  function decide(job) {
    const h = findEntry(job.strat, market, rows, { size, requireDepth, from: job.from });
    if (!h) { job.d = null; return; }
    job.tries++;
    job.d = { t: h.row.t, i: h.i, side: h.side, price: h.price, qty: h.qty, priceMax: job.strat.entry?.priceMax ?? 1 };
    job.firstSide ??= h.side;
    job.q = job.d.t + job.delay;
  }
  const finish = (job, res) => { out[job.name][job.v.key][job.delay] = res; job.d = null; };
  const cursor = bookCursor(w);
  for (;;) {
    let job = null;
    for (const j of jobs) if (j.d && (!job || j.q < job.q)) job = j;
    if (!job) break;
    const { d, v } = job;
    let fill;
    if (job.q >= market.close) fill = { n: 0, cost: 0, pq: 0 };
    else {
      const snap = cursor.at(job.q);
      if (!snap) { finish(job, { unknown: true, tries: job.tries }); continue; }
      const limit = Math.min(r4(d.price + v.cents / 100), Math.max(d.price, d.priceMax));
      fill = walkFill(snap, d.side, limit, d.qty);
    }
    if (fill.n > 0) { finish(job, { tries: job.tries, n: fill.n, cost: fill.cost, pq: fill.pq, side: d.side, price: d.price }); continue; }
    if (!v.retry || job.q >= market.close) { finish(job, { tries: job.tries, n: 0, side: job.firstSide }); continue; }
    // Re-check the rule from the first row at or after the reply.
    let i = d.i + 1;
    while (i < rows.length && rows[i].t < job.q) i++;
    job.from = i;
    const tries = job.tries;
    decide(job);
    if (!job.d) out[job.name][v.key][job.delay] = { tries, n: 0, side: job.firstSide };
  }
  return out;
}
