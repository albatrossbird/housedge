// Does Kalshi's 15-minute Bitcoin book lag the index it settles on?
// (scripts/brti-lag.mjs reads the archive; this file holds the arithmetic.)
//
// An EVENT is the first BRTI tick at which the index has moved at least
// `thrBp` basis points from where it stood `lookMs` earlier — the earliest
// moment a bot watching the index would know. The RESPONSE is how far
// Kalshi's book had moved in the same direction, measured from the same
// starting point (`lookMs` before the event), at each horizon after it.
// If most of the eventual repricing is already done at +0ms, the book
// moves with the index and there is no lag to trade; if it arrives over
// the following second, that second is the opportunity.

// The last row at or before t (rows sorted by t), or null.
export function atOrBefore(rows, t) {
  let lo = 0, hi = rows.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].t <= t) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best < 0 ? null : rows[best];
}

// ticks: [{ t, v }] sorted by t. A tick older than lookMs + staleMs at
// the look-back point is not a baseline: the index was silent, and a move
// measured across a silence is not a 1-second move. One event per
// `gapMs`, so a single jump is not counted on each of its ticks.
export function findMoves(ticks, { thrBp, lookMs = 1000, staleMs = 500, gapMs = 2000, from = -Infinity, to = Infinity }) {
  const out = [];
  let last = -Infinity;
  for (const k of ticks) {
    if (k.t < from || k.t > to || k.t - last < gapMs) continue;
    const b = atOrBefore(ticks, k.t - lookMs);
    if (!b || k.t - lookMs - b.t > staleMs || !(b.v > 0)) continue;
    const bp = (k.v - b.v) / b.v * 1e4;
    if (Math.abs(bp) < thrBp) continue;
    out.push({ t: k.t, dir: bp > 0 ? 1 : -1, bp });
    last = k.t;
  }
  return out;
}

// rows: the book's path [{ t, bid, ask }] sorted by t. For an up move the
// side to buy is YES at the ask; for a down move NO at 1 - bid. "mid" and
// "pay" are each signed toward the move, in cents, from the baseline. A
// horizon with no book (before the first row) makes the whole event null:
// a response measured against a missing baseline is not a response.
export function response(rows, ev, horizons, { lookMs = 1000 } = {}) {
  const base = atOrBefore(rows, ev.t - lookMs);
  if (!base) return null;
  const mid = r => (r.bid + r.ask) / 2;
  const pay = r => (ev.dir > 0 ? r.ask : 1 - r.bid);
  const out = { baseMid: mid(base), at: {} };
  for (const h of horizons) {
    const r = atOrBefore(rows, ev.t + h);
    if (!r) return null;
    out.at[h] = {
      mid: Math.round(ev.dir * (mid(r) - mid(base)) * 1e4) / 100,
      pay: Math.round((pay(r) - pay(base)) * 1e4) / 100,
    };
  }
  return out;
}

// Mean signed move at each horizon, its share of the move at the last
// horizon, and how often the book had moved at least 1c toward the index.
export function summarise(resps, horizons, key = "mid") {
  const n = resps.length, last = horizons[horizons.length - 1];
  const mean = h => n ? resps.reduce((s, r) => s + r.at[h][key], 0) / n : null;
  const end = mean(last);
  return {
    n,
    rows: horizons.map(h => ({
      h,
      mean: mean(h),
      share: end ? mean(h) / end : null,
      moved1c: n ? resps.filter(r => r.at[h][key] >= 1 - 1e-9).length / n : null,
    })),
  };
}
