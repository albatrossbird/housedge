// Try many strategies at once, and report what trying many costs.
//
// WHY THIS IS NOT JUST A LOOP OVER audit(). Running seventy variants
// against ten days of data and publishing the best one is not research,
// it is the manufacturing process for a backtest. At the conventional
// two-sigma bar, roughly one in twenty-two independent tests clears by
// chance alone — so a seventy-strategy sweep expects THREE winners on
// pure noise, and will find them, and they will look exactly like the
// real thing.
//
// This project exists to falsify other people's performance claims. A
// sweep here that did not correct for its own multiplicity would be
// doing the thing it criticises, on its own data, in public.
//
// THE CORRECTION IS A PARAMETRIC BOOTSTRAP, not Bonferroni. Bonferroni
// assumes the tests are independent and these are emphatically not:
// "buy 0.85-0.95 at T-90" and "buy 0.85-0.95 at T-300" enter many of
// the same markets, so the family-wise error is far smaller than the
// count implies and Bonferroni would reject real findings. Instead the
// null is simulated on the ACTUAL entries, which carries their overlap
// for free.
//
// THE NULL IS "THE MARKET IS CALIBRATED", which is the hypothesis a
// strategy has to beat. Under it, a contract bought at 92c wins 92% of
// the time — so edge-over-price has expectation zero by construction,
// and every cent of measured edge is either information or noise. One
// uniform draw per MARKET, shared across strategies and across sides,
// because a market resolves once: yes and no cannot both win, and
// strategies that entered the same market must agree about what
// happened to it.

import { feeOf } from "./calibrate.js";
import { entryFor } from "./strategyAudit.js";

// Collect, for every strategy, the entries it takes — price, side, the
// market's implied yes-probability at that moment, and the ticker.
// Scoring is separated from selection so the null can rescore the same
// entries without re-running the filters.
export function collectEntries(observations, specs) {
  const per = specs.map(() => []);
  for (const q of observations) {
    const bid = Number(q.yes_bid), ask = Number(q.yes_ask);
    for (let i = 0; i < specs.length; i++) {
      const hit = entryFor(q, specs[i]);
      if (!hit) continue;
      // impliedYes is the market's own probability of YES at entry. For
      // a yes fill that is the ask paid; for a no fill at (1 - bid) the
      // yes side is the bid. Keeping it explicit is what lets one
      // uniform per market score both sides consistently.
      const impliedYes = hit.side === "yes" ? ask : bid;
      per[i].push({ ticker: q.ticker, side: hit.side, price: hit.price, impliedYes });
    }
  }
  return per;
}

// Score a set of entries against a win-test. `won(entry)` is the only
// thing that differs between the real run and a simulated one.
export function score(entries, mult, won, dayOf) {
  if (!entries.length) return null;
  let wins = 0, net = 0, sum = 0;
  const days = new Set();
  for (const e of entries) {
    const w = won(e);
    if (w) wins++;
    const f = feeOf(e.price, mult);
    net += w ? 1 - e.price - f : -(e.price + f);
    sum += e.price;
    const d = dayOf?.(e.ticker);
    if (d) days.add(d);
  }
  const n = entries.length;
  const avgEntry = sum / n, winRate = wins / n;
  return {
    n, wins, avgEntry, winRate,
    edgeOverPrice: winRate - avgEntry,
    netPer: net / n,
    se: Math.sqrt(winRate * (1 - winRate) / n),
    days: days.size,
  };
}

// The real outcome: did the side taken match how the market settled?
export const realWin = resultOf => e => resultOf.get(e.ticker) === e.side;

// A deterministic PRNG, so a reported null is reproducible. Math.random
// would make the correction unrepeatable, and a correction nobody can
// re-derive is a number to be taken on trust — which is the posture
// this whole harness exists to refuse.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One draw per market, shared by every strategy and both sides.
//
// A yes entry wins when the draw falls below the market's implied yes
// probability. A no entry wins when it does not. Using the SAME draw is
// what keeps the simulation coherent: two strategies that both entered
// KXBTC15M-26SEP16T1400 see the same market resolve the same way, and
// a yes and a no on it cannot both be paid.
export function simulatedWin(rand, tickers) {
  const u = new Map();
  for (const t of tickers) u.set(t, rand());
  return e => (e.side === "yes" ? u.get(e.ticker) < e.impliedYes
                                : u.get(e.ticker) >= e.impliedYes);
}

// How large an edge does the BEST of these strategies reach when there
// is nothing to find?
//
// The statistic is the maximum across the family, per simulated world —
// which is the quantity that actually needs correcting. Comparing the
// best real result against the distribution of best NULL results is a
// permutation test on the maximum, and it answers the only question
// that matters about a sweep: could the winner have come from noise.
export function nullDistribution(perStrategy, mult, { draws = 400, seed = 20260916 } = {}) {
  const tickers = [...new Set(perStrategy.flat().map(e => e.ticker))];
  const rand = mulberry32(seed);
  const bestEdge = [], bestNet = [];
  for (let d = 0; d < draws; d++) {
    const won = simulatedWin(rand, tickers);
    let me = 0, mn = -Infinity;
    for (const entries of perStrategy) {
      if (!entries.length) continue;
      const s = score(entries, mult, won);
      me = Math.max(me, Math.abs(s.edgeOverPrice));
      mn = Math.max(mn, s.netPer);
    }
    bestEdge.push(me);
    if (Number.isFinite(mn)) bestNet.push(mn);
  }
  bestEdge.sort((a, b) => a - b);
  bestNet.sort((a, b) => a - b);
  return { bestEdge, bestNet, draws };
}

export const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;

// The share of simulated worlds in which noise matched or beat the real
// result. This IS the multiplicity-corrected p-value for the sweep.
export const pValue = (sorted, observed) =>
  sorted.length ? (sorted.filter(v => v >= observed).length + 1) / (sorted.length + 1) : null;
