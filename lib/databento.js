// Reading what scripts/databento-fetch.py bought — CME futures prices at
// each 15-minute boundary — as a reader lib/dukascopy.js's compareSeries
// can score against Kalshi's settlement prices (m15_settlements).
//
// The script has the why. Two things only matter here:
//   - A boundary with no file covering it is MISSING (not bought); one
//     covered with no trade in the last 60s is STALE. A quiet market is a
//     fact about the market, an unbought hour is a fact about us.
//   - Futures units are not always Pyth's. 6J is USD per yen where
//     KXUSDJPY15M settles on yen per dollar, so it is inverted BEFORE the
//     move is read, or every side would read backwards. Any other unit gap
//     (copper per pound vs per tonne) is found from the data and printed,
//     never assumed.

export const DATABENTO_ROOTS = {
  KXGOLD15M: "GC", KXSILVER15M: "SI", KXWTI15M: "CL", KXNATGAS15M: "NG",
  KXCOPPER15M: "HG", KXPLATINUM15M: "PL", KXPALLADIUM15M: "PA",
  KXEURUSD15M: "6E", KXGBPUSD15M: "6B", KXUSDJPY15M: "6J",
};
export const INVERTED = new Set(["6J"]);

// "<root>.<schema>.<startMs>-<endMs>.csv" -> its span, or null.
export function chunkSpan(name, root, schema) {
  const p = `${root}.${schema}.`;
  if (!name.startsWith(p) || !name.endsWith(".csv")) return null;
  const [s, e] = name.slice(p.length, -4).split("-").map(Number);
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? [s, e] : null;
}

export function parseChunk(text) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const [b, px, end] = line.split(",").map(Number);
    if (Number.isFinite(b) && Number.isFinite(px) && px > 0 && Number.isFinite(end)) out.push({ b, px, end });
  }
  return out;
}

// chunks: [{ span: [s, e], rows }]. A boundary t is covered when some
// chunk holds the bars ending in (t - 60s, t], i.e. s <= t - 60s and t <= e.
export function boundaryReader(chunks, { invert = false, factor = 1 } = {}) {
  const at = new Map();
  for (const c of chunks) for (const r of c.rows) at.set(r.b, { px: (invert ? 1 / r.px : r.px) * factor, end: r.end });
  const spans = chunks.map(c => c.span);
  const covered = t => spans.some(([s, e]) => s <= t - 60000 && t <= e);
  return {
    mid(t) {
      const r = at.get(t);
      if (r) return { mid: r.px, age: t - r.end };
      return covered(t) ? { stale: true } : { missing: true };
    },
    size: at.size,
  };
}

// The unit factor that brings the futures price to Pyth's, from pairs of
// [futures, settlement]: the candidate with the smallest median relative
// error. Ratios a steady basis cannot explain (lb vs tonne, a cents quote)
// are what it is for; the basis itself stays in the level figure.
const LB_PER_TONNE = 2204.62262;
const FACTORS = [1, 10, 100, 1000, 0.1, 0.01, 0.001, LB_PER_TONNE, 1 / LB_PER_TONNE];
export function unitFactor(pairs) {
  if (!pairs.length) return { factor: 1, medErr: null };
  let best = null;
  for (const f of FACTORS) {
    const errs = pairs.map(([px, v]) => Math.abs(px * f - v) / Math.abs(v)).sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    if (!best || med < best.medErr) best = { factor: f, medErr: med };
  }
  return best;
}
