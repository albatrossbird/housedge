// Probability, expected value and position size for a backtested rule.
// Pure: fed the trades lib/m15Backtest.js produces (hold to settlement),
// it answers four questions and says how sure it is of each.
//
//   1. PRICED vs WON. A contract bought at 0.85 is the market saying 85%.
//      The rule has an edge only if its side wins more often than the
//      ALL-IN price — entry plus Kalshi's fee per contract — which is the
//      breakeven win rate. Shown per price band too (calibration), since
//      an average over 0.70 and 0.95 entries can hide a band that loses.
//   2. EV per contract, after fees, with a range from resampling whole
//      DAYS. Windows on the same day ride the same underlying and are not
//      independent; resampling trades would claim a precision the sample
//      does not have.
//   3. SHARPE. Daily P&L mean over its standard deviation, and that times
//      the square root of trading days a year. With a handful of days it
//      is a description of those days, not a forecast.
//   4. KELLY. For a contract bought at all-in cost c that pays $1 with
//      probability q, the growth-optimal stake is f* = (q - c) / (1 - c)
//      of bankroll. It is computed at the point estimate AND at the low
//      end of q's range: the point estimate assumes q is known exactly,
//      and Kelly sized on an overestimated q loses money for sure. Below
//      zero means do not bet.
//
// Deterministic: the bootstrap uses a seeded generator, so the same
// trades always print the same ranges.

const day = t => new Date(t.close).toISOString().slice(0, 10);
const allIn = t => t.entry + (t.entryFee || 0) / t.qty;

// Wilson score interval for k successes in n trials.
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = p + z2 / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lo: (c - h) / d, hi: (c + h) / d };
}

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const quantile = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))]; };

// A statistic's 95% range when whole days are resampled with replacement.
export function dayBootstrap(trades, stat, { iters = 2000, seed = 7 } = {}) {
  const byDay = new Map();
  for (const t of trades) { const d = day(t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(t); }
  const days = [...byDay.values()];
  if (days.length < 2) return null;
  const r = rng(seed), out = [];
  for (let i = 0; i < iters; i++) {
    const sample = [];
    for (let j = 0; j < days.length; j++) sample.push(...days[Math.floor(r() * days.length)]);
    const v = stat(sample);
    if (Number.isFinite(v)) out.push(v);
  }
  return out.length ? { lo: quantile(out, 0.025), hi: quantile(out, 0.975) } : null;
}

export const kelly = (q, c) => (c > 0 && c < 1 && Number.isFinite(q) ? (q - c) / (1 - c) : null);

export function ruleStats(trades, { daysPerYear = 365 } = {}) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.won).length;
  const q = wins / n;
  const priced = trades.reduce((s, t) => s + t.entry, 0) / n;
  const breakeven = trades.reduce((s, t) => s + allIn(t), 0) / n;
  const contracts = trades.reduce((s, t) => s + t.qty, 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const qCI = wilson(wins, n);
  const qBoot = dayBootstrap(trades, ts => ts.filter(t => t.won).length / ts.length);
  const evBoot = dayBootstrap(trades, ts => ts.reduce((s, t) => s + t.pnl, 0) / ts.reduce((s, t) => s + t.qty, 0));
  // The more cautious of the two low ends: Wilson ignores that trades on
  // one day move together; the day bootstrap is coarse with few days.
  const qLo = Math.min(qCI.lo, qBoot ? qBoot.lo : qCI.lo);

  const byDay = new Map();
  for (const t of trades) byDay.set(day(t), (byDay.get(day(t)) || 0) + t.pnl);
  const daily = [...byDay.values()];
  const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((s, v) => s + (v - mean) ** 2, 0) / (daily.length - 1)) : null;
  const sharpeDaily = sd > 1e-12 ? mean / sd : null;

  return {
    n, days: daily.length, contracts, wins, winRate: q, winCI: qCI, winBoot: qBoot,
    priced, breakeven, edgePts: q - breakeven,
    evPerContract: pnl / contracts, evBoot,
    sharpeDaily, sharpeAnnual: sharpeDaily == null ? null : sharpeDaily * Math.sqrt(daysPerYear), daysPerYear,
    kelly: kelly(q, breakeven), kellyLow: kelly(qLo, breakeven), winLow: qLo,
  };
}

// Priced against won, per band of entry price.
export const BANDS = [[0, 0.5], [0.5, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0001]];
export function calibration(trades, bands = BANDS) {
  return bands.map(([lo, hi]) => {
    const ts = trades.filter(t => t.entry >= lo && t.entry < hi);
    return { lo, hi, n: ts.length, priced: ts.length ? ts.reduce((s, t) => s + t.entry, 0) / ts.length : null,
      breakeven: ts.length ? ts.reduce((s, t) => s + allIn(t), 0) / ts.length : null,
      won: ts.length ? ts.filter(t => t.won).length / ts.length : null };
  }).filter(b => b.n);
}
