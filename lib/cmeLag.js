// Does Kalshi's commodity or FX 15-minute book lag the CME future?
// The same question lib/brtiLag.js asks of Bitcoin and BRTI, with CME's
// best bid and offer each second (Databento bbo-1s, exported by
// scripts/databento-ticks.py) in place of the index. The event and
// response arithmetic is brtiLag's, unchanged; this file holds what is
// different about the CME path.
//
//   - A bbo-1s record prints only when the book or a trade changed, so a
//     mid STANDS until the next row. BRTI ticks five times a second and a
//     quiet second there means a silent feed; here it means an unchanged
//     book. The baseline may therefore be older than the look-back, up to
//     BASELINE_MAX_MS. Older than that is a market that was shut (CME's
//     daily break), and a "move" measured across it is not a one-second
//     move.
//   - A row is stamped at the END of its one-second interval: the move it
//     shows happened somewhere in the second before. A bot on a tick feed
//     would know up to a second sooner, so the book's response at +0 here
//     can include repricing a faster bot would have beaten. That biases
//     this test TOWARD "already priced", never away from it.
//   - 6J is USD per yen; KXUSDJPY15M is yen per dollar. Inverted on read.

import { findMoves } from "./brtiLag.js";

export const BASELINE_MAX_MS = 60000;

// "ms,mid\n..." -> { t: Float64Array, v: Float64Array }, sorted by t.
export function parseTicks(text, { invert = false } = {}) {
  const t = [], v = [];
  for (const line of text.split("\n")) {
    const c = line.indexOf(",");
    if (c < 0) continue;
    const ms = Number(line.slice(0, c)), px = Number(line.slice(c + 1));
    if (!Number.isFinite(ms) || !(px > 0)) continue;   // the header, blanks, junk
    t.push(ms); v.push(invert ? 1 / px : px);
  }
  const order = t.map((_, i) => i).sort((a, b) => t[a] - t[b]);
  return { t: Float64Array.from(order, i => t[i]), v: Float64Array.from(order, i => v[i]) };
}

// The first index with t >= ms.
function lowerBound(T, ms) {
  let lo = 0, hi = T.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (T.t[m] < ms) lo = m + 1; else hi = m; }
  return lo;
}

// Ticks in [from, to] as [{ t, v }], plus the last tick before `from`:
// a book that has not changed since then still stands at `from`, and
// findMoves needs it as the baseline for the first events.
export function ticksIn(T, from, to) {
  const out = [];
  let i = lowerBound(T, from);
  if (i > 0) i--;
  for (; i < T.t.length && T.t[i] <= to; i++) out.push({ t: T.t[i], v: T.v[i] });
  return out;
}

// Sharp CME moves: brtiLag's findMoves, with a baseline allowed to stand
// as long as an unchanged book does (see the header).
export function cmeMoves(ticks, { thrBp, lookMs = 1000, from, to }) {
  return findMoves(ticks, { thrBp, lookMs, staleMs: BASELINE_MAX_MS - lookMs, from, to });
}

// Was CME trading in this window's final two minutes? A front-month book
// changes every second while open, so no row at all in that stretch is a
// market that was shut (the daily break, a weekend edge). Counted apart,
// so "no events" is not read as "no moves".
export function cmeOpen(T, close) {
  const i = lowerBound(T, close - 120000);
  return i < T.t.length && T.t[i] <= close;
}
