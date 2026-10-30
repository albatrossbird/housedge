// WHEN does a Pyth-settled 15-minute market take its settlement price?
//
// Kalshi's rules (KXGOLD15M / KXWTI15M, read 2026-10-30): YES if "the close
// price of the 1-minute candlestick ... at 11:00 PM" is at least the close
// of the one "at 10:45 PM", and "the candlestick timestamped 4:59 PM ...
// closes at 5:00:00 PM". Read literally, the 11:00 candle closes at
// 11:01:00 — a minute AFTER trading stops. A single print, not an average.
//
// The data can say which. The settlement minus the strike is Pyth's own
// move over the window (m15_settlements: value - strike). CME's move over
// the same fifteen minutes, shifted by an offset o, tracks it best when o
// is the instant Pyth's prints were taken. Fit and score at every offset;
// the peak is the answer. Futures carry a basis to spot, but a basis that
// barely changes in fifteen minutes cancels in a move.
//
// T: { t: Float64Array (ms), v: Float64Array } sorted (lib/cmeLag.js).

export const STALE_MS = 60000;

// The CME mid standing at ms: the last row at or before it, no older than
// STALE_MS (a bbo-1s row stands until the book changes; older is a shut
// market). Null if none.
export function priceAt(T, ms) {
  let lo = 0, hi = T.t.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (T.t[m] <= ms) { best = m; lo = m + 1; } else hi = m - 1; }
  return best < 0 || ms - T.t[best] > STALE_MS ? null : T.v[best];
}

// windows: [{ close, strike, value, result }] (ms, Pyth prices, "yes"/"no").
// Returns, for one offset, how well CME's shifted move explains Pyth's.
export function scoreOffset(T, windows, offsetMs, { windowMs = 900000 } = {}) {
  const pts = [];
  for (const w of windows) {
    const c1 = priceAt(T, w.close + offsetMs), c0 = priceAt(T, w.close - windowMs + offsetMs);
    if (c1 == null || c0 == null || !Number.isFinite(w.value) || !Number.isFinite(w.strike)) continue;
    pts.push({ dc: c1 - c0, dp: w.value - w.strike, yes: w.result === "yes" });
  }
  const n = pts.length;
  if (n < 3) return { offsetMs, n, corr: null, slope: null, rmse: null, side: null, near: null };
  const mc = pts.reduce((s, p) => s + p.dc, 0) / n, mp = pts.reduce((s, p) => s + p.dp, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.dc - mc) * (p.dp - mp); sxx += (p.dc - mc) ** 2; syy += (p.dp - mp) ** 2; }
  const corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  // Through the origin: a unit gap (copper per pound vs tonne, an inverted
  // quote) is a scale, not an intercept.
  const slope = pts.reduce((s, p) => s + p.dc * p.dp, 0) / pts.reduce((s, p) => s + p.dc * p.dc, 0);
  const rmse = Math.sqrt(pts.reduce((s, p) => s + (p.dp - slope * p.dc) ** 2, 0) / n);
  // Side: does CME's shifted move point the way Kalshi settled? A flat CME
  // move is no call and counts against. "near": the fifth of windows whose
  // Pyth move was smallest, where timing matters most.
  const agrees = p => (p.dc * slope > 0 && p.yes) || (p.dc * slope < 0 && !p.yes);
  const byClose = [...pts].sort((a, b) => Math.abs(a.dp) - Math.abs(b.dp)).slice(0, Math.max(1, Math.floor(n / 5)));
  return {
    offsetMs, n, corr, slope, rmse,
    side: pts.filter(agrees).length / n,
    near: byClose.filter(agrees).length / byClose.length,
  };
}
