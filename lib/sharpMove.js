// The sharp-move entry on KXBTC15M, as one streaming decider: the code the
// index backtest (scripts/m15-index.mjs, section D) decides with, and the
// code a live bot copies. Feed it BRTI 5Hz ticks in order; it says when to
// send an order and why it passed over a move it did not trade.
//
// The rule:
//   - A tick is timed by CF Benchmarks' own stamp (source_ts_ms), not by
//     when it arrived. Its value is value_usd, a STRING on the wire: parse
//     it with Number() before it reaches here.
//   - Only ticks from 118s to 6s before the close can be events.
//   - The move is measured against the last tick at or before 1000ms
//     earlier. That baseline must be no more than 500ms older than the
//     point it stands for, or there is no move to measure (a silence is
//     not a move).
//   - |move| >= 1bp is an EVENT. Events are at least 2000ms apart, and an
//     event the book check passes over still starts that 2000ms.
//   - The book at the event's instant must be two-sided with its mid in
//     0.15-0.85 inclusive; otherwise the event is skipped and a later one
//     may still trade.
//   - Up move: buy YES; the price seen is the YES ask. Down move: buy NO;
//     the price seen is 1 - YES bid. Limit = seen + 1c, capped at 0.99.
//   - The first event the book check passes is the window's only order.
//     Held to settlement.
//
// Ticks must arrive in non-decreasing source_ts order. One that goes
// backwards is refused and reported, never inserted: the backtest feeds a
// sorted record, and a live socket that reorders is a fact to log rather
// than to paper over.

import { atOrBefore } from "./brtiLag.js";

export const SHARP_MOVE = Object.freeze({
  thrBp: 1, lookMs: 1000, staleMs: 500, gapMs: 2000,
  fromSecs: 118, toSecs: 6, midLo: 0.15, midHi: 0.85,
  limitCents: 1, limitCap: 0.99,
});

const r4 = x => Math.round(x * 10000) / 10000;

// closeMs: the window's close (ms). bookAt(t) -> { bid, ask } (YES prices,
// either may be null/undefined for an empty side) or null: the book as it
// stood at instant t. Called only on an event, once per event.
//
// onTick(t, v, bookAt) returns:
//   null                                   nothing to report
//   { t, skip: "out of order", last }      t went backwards; tick dropped
//   { t, skip: "stale baseline", bp, baseT } a move this size, measured
//                                          across a silence: not an event
//   { t, skip: "no two-sided book", bp, bid, ask }   an event, passed over
//   { t, skip: "book out of band", bp, bid, ask, mid } an event, passed over
//   { t, bp, bid, ask, mid, order: { side, seen, limit } }  send it; the
//                                          decider is done for the window
export function createSharpMove(closeMs, params = {}) {
  const p = { ...SHARP_MOVE, ...params };
  const from = closeMs - p.fromSecs * 1000, to = closeMs - p.toSecs * 1000;
  const buf = [];
  let lastT = -Infinity, lastEvent = -Infinity, done = false;
  return {
    get done() { return done; },
    onTick(t, v, bookAt) {
      if (done) return null;
      if (t < lastT) return { t, skip: "out of order", last: lastT };
      lastT = t;
      buf.push({ t, v });
      // A tick is never a baseline again once a later one is also at or
      // before the look-back point: the latest such tick always wins.
      while (buf.length > 1 && buf[1].t <= t - p.lookMs) buf.shift();
      if (t < from || t > to || t - lastEvent < p.gapMs) return null;
      const b = atOrBefore(buf, t - p.lookMs);
      if (!b || !(b.v > 0)) return null;
      const bp = (v - b.v) / b.v * 1e4;
      if (Math.abs(bp) < p.thrBp) return null;
      if (t - p.lookMs - b.t > p.staleMs) return { t, skip: "stale baseline", bp, baseT: b.t };
      lastEvent = t;
      const bk = bookAt(t), bid = bk?.bid ?? null, ask = bk?.ask ?? null;
      if (bid == null || ask == null) return { t, skip: "no two-sided book", bp, bid, ask };
      const mid = (bid + ask) / 2;
      if (mid < p.midLo || mid > p.midHi) return { t, skip: "book out of band", bp, bid, ask, mid };
      const side = bp > 0 ? "yes" : "no", seen = side === "yes" ? ask : r4(1 - bid);
      done = true;
      return { t, bp, bid, ask, mid, order: { side, seen, limit: Math.min(r4(seen + p.limitCents / 100), p.limitCap) } };
    },
  };
}

// One window of a test vector (scripts/sharp-move-vector.mjs) through the
// decider: rows are [source_ts_ms, value_usd string, YES bid, YES ask], the
// book being the touch at that tick's instant. Returns every non-null
// decision, in order.
export function replayVector(closeMs, rows, params = {}) {
  const book = new Map(rows.map(r => [r[0], { bid: r[2], ask: r[3] }]));
  const dec = createSharpMove(closeMs, params), out = [];
  for (const [t, s] of rows) {
    const r = dec.onTick(t, Number(s), at => book.get(at) ?? null);
    if (r) out.push(r);
  }
  return out;
}
