// A live Kalshi order book, kept from the WebSocket's snapshot + deltas.
//
// PRICES ARE INTEGER TENTHS OF A CENT. Levels arrive as four-decimal
// strings and some markets tick below a cent; keying a Map on floats
// would let "0.3800" and 0.38000000000000006 become two levels.
//
// TWO BID STACKS, ONE BOOK. Kalshi publishes resting YES bids and
// resting NO bids. A NO bid is a YES offer, so the ask side of the YES
// book IS the NO stack. How its prices arrive depends on the subscribe
// flag `use_yes_price`:
//
//   false (the legacy default)  NO levels in no-leg pricing: a NO bid at
//                               0.30 is a YES offer at 0.70 -> mirror.
//   true                        NO levels already in yes-leg pricing:
//                               that same level arrives as 0.70.
//
// Kalshi has announced the default flips to true and the flag is then
// REMOVED. A recorder relying on the default would silently start
// reading every ask on the wrong side of the book on the day it flips,
// with nothing failing — the book would still look like a book. So the
// recorder always sends the flag explicitly, and `yesLeg` here must match
// what was sent. scripts/kalshi-book.test.mjs requires both encodings of
// the same market to produce the IDENTICAL book.
//
// SEQUENCE. `seq` counts messages per SUBSCRIPTION (sid), not per market,
// so one lost message means any market on that sid may be wrong. A gap
// marks every market on the sid untrusted until its own fresh snapshot
// arrives; the caller asks for those with `get_snapshot`. Deltas for an
// untrusted market are dropped rather than applied to a book known to be
// incomplete, and the gap is RETURNED so it can be recorded — a backtest
// has to be able to tell "the book did not change" from "we do not know".

const milli = p => Math.round(Number(p) * 1000);
const size2 = s => Math.round(Number(s) * 100) / 100;

export class BookSet {
  constructor({ yesLeg = true } = {}) {
    this.yesLeg = yesLeg;
    this.books = new Map();     // ticker -> { bids: Map<milli,size>, asks: Map<milli,size>, fresh, sid, tsMs }
    this.lastSeq = new Map();   // sid -> last seq seen
    this.stats = { snapshots: 0, deltas: 0, droppedUntrusted: 0, gaps: 0 };
  }

  // The NO stack, converted to YES-offer prices.
  askPrice(p) { return this.yesLeg ? milli(p) : 1000 - milli(p); }

  // Returns { gap: {sid, expected, got, tickers} } when a sequence gap
  // was found on this message's subscription, else {}.
  apply(frame) {
    const { type, sid, seq, msg } = frame || {};
    if (type !== "orderbook_snapshot" && type !== "orderbook_delta") return {};
    let gap = null;
    if (sid != null && seq != null) {
      const last = this.lastSeq.get(sid);
      if (last != null && seq !== last + 1) {
        const tickers = [...this.books].filter(([, b]) => b.sid === sid).map(([t]) => t);
        for (const t of tickers) this.books.get(t).fresh = false;
        gap = { sid, expected: last + 1, got: seq, tickers };
        this.stats.gaps++;
      }
      this.lastSeq.set(sid, seq);
    }
    const t = msg?.market_ticker;
    if (!t) return gap ? { gap } : {};

    if (type === "orderbook_snapshot") {
      const bids = new Map(), asks = new Map();
      for (const [p, s] of msg.yes_dollars_fp || msg.yes_dollars || []) if (size2(s) > 0) bids.set(milli(p), size2(s));
      for (const [p, s] of msg.no_dollars_fp || msg.no_dollars || []) if (size2(s) > 0) asks.set(this.askPrice(p), size2(s));
      this.books.set(t, { bids, asks, fresh: true, sid, tsMs: msg.ts_ms ?? null });
      this.stats.snapshots++;
      return gap ? { gap } : {};
    }

    // Delta: `delta_fp` is the CHANGE in resting size at that level.
    const b = this.books.get(t);
    if (!b || !b.fresh) { this.stats.droppedUntrusted++; return gap ? { gap } : {}; }
    const side = msg.side === "yes" ? b.bids : msg.side === "no" ? b.asks : null;
    if (!side) return gap ? { gap } : {};
    const p = msg.side === "yes" ? milli(msg.price_dollars) : this.askPrice(msg.price_dollars);
    const next = size2((side.get(p) || 0) + Number(msg.delta_fp));
    if (next > 0) side.set(p, next); else side.delete(p);
    if (msg.ts_ms != null) b.tsMs = msg.ts_ms;
    this.stats.deltas++;
    return gap ? { gap } : {};
  }

  isFresh(t) { return !!this.books.get(t)?.fresh; }
  drop(t) { this.books.delete(t); }

  // Best YES bid / ask and the size resting there. Null when the book is
  // unknown; a side with nothing resting has a null price and size 0 —
  // the same null-is-not-zero rule the polling recorder keeps.
  touch(t) {
    const b = this.books.get(t);
    if (!b || !b.fresh) return null;
    const bid = b.bids.size ? Math.max(...b.bids.keys()) : null;
    const ask = b.asks.size ? Math.min(...b.asks.keys()) : null;
    return {
      bid: bid == null ? null : bid / 1000, ask: ask == null ? null : ask / 1000,
      bidSize: bid == null ? 0 : b.bids.get(bid), askSize: ask == null ? 0 : b.asks.get(ask),
      tsMs: b.tsMs,
    };
  }

  // Contracts within N cents of the touch, touch inclusive — the same
  // definition as the polling recorder's bid_depth_Nc / ask_depth_Nc, so
  // the two sources can be compared column for column.
  depth(t, windows = [1, 3, 5]) {
    const b = this.books.get(t);
    if (!b || !b.fresh) return null;
    const bb = b.bids.size ? Math.max(...b.bids.keys()) : null;
    const ba = b.asks.size ? Math.min(...b.asks.keys()) : null;
    const out = {};
    for (const w of windows) {
      let bs = 0, as = 0;
      if (bb != null) for (const [p, s] of b.bids) if (bb - p <= w * 10) bs += s;
      if (ba != null) for (const [p, s] of b.asks) if (p - ba <= w * 10) as += s;
      out[`bid_${w}c`] = size2(bs); out[`ask_${w}c`] = size2(as);
    }
    return out;
  }

  // The best N levels each side, best first, in YES-leg dollars.
  levels(t, n = 10) {
    const b = this.books.get(t);
    if (!b || !b.fresh) return null;
    const bids = [...b.bids].sort((x, y) => y[0] - x[0]).slice(0, n).map(([p, s]) => [p / 1000, s]);
    const asks = [...b.asks].sort((x, y) => x[0] - y[0]).slice(0, n).map(([p, s]) => [p / 1000, s]);
    return { bids, asks };
  }
}
