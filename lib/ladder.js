// Ladder consistency (docs/research/ladder-plan.md): the pure parts.
//
// A Kalshi crypto strike market resolves on one number, the 60-second
// average of a CF Benchmarks index before its close. Two markets on the
// same index and the same close are therefore events on one variable, and
// one can IMPLY the other: "above 100,000" implies "above 99,500". When X
// implies Y, P(X) <= P(Y), and a YES bid on X above the YES ask on Y is a
// contradiction: buying NO on X and YES on Y pays at least $1 in every
// state.
//
// The event is read from the structured strike fields, never the title.
// The index is read from rules_primary, because the series list names the
// settlement SOURCE (CF Benchmarks) and not which of its indices.

// rules_primary -> the index and averaging it settles on, or null when the
// wording is not a 60-second CF Benchmarks average before the close. A
// market we cannot read is left out, never guessed. Kalshi words the same
// rule three ways, all seen live on 2026-11-14:
//   "the simple average of the sixty seconds of CF Benchmarks' X before"  (BTC, ETH, SOL, ...)
//   "the simple average of the 60 seconds of CF Benchmarks' X before"     (Shiba)
//   "a 60 second average of CF Benchmarks' X before"                      (Dogecoin)
//   "...sixty seconds of CF Benchmarks' Bitcoin Real-Time Index (BRTI) before..." -> "BRTI"
//   "...sixty seconds of CF Benchmarks' SOLUSD_RTI before..."                    -> "SOLUSD_RTI"
//   "...sixty seconds of CF Benchmarks' BRTI before..."                          -> "BRTI"
export function settlementIndex(rules) {
  const m = /(?:simple average of the (?:sixty|60) seconds|a (?:sixty|60) second average) of CF Benchmarks' (.+?) before /.exec(String(rules || ""));
  if (!m) return null;
  const paren = /\(([A-Z0-9_]+)\)\s*$/.exec(m[1]);
  if (paren) return paren[1];
  return /^[A-Z0-9_]+$/.test(m[1]) ? m[1] : null;
}

// A market's Yes event as an interval of the settlement value:
// { lo, loIn, hi, hiIn } with +-Infinity for an open side. Null for any
// strike_type not listed here, or a missing strike.
//   greater          S >  floor        greater_or_equal  S >= floor
//   less             S <  cap          less_or_equal     S <= cap
//   between          floor <= S <= cap ("between 64000-64499.99", both
//                    ends inclusive, as the rules state it)
//
// Dogecoin and Shiba arrive as strike_type "custom" with the real type and
// strikes, as strings, inside custom_strike (seen live 2026-11-14:
// {"strike_type":"greater","floor_strike":"0.2449999","cap_strike":""}).
export function eventOf(m) {
  if (m.strike_type === "custom" && m.custom_strike && m.custom_strike.strike_type !== "custom") {
    const cs = m.custom_strike;
    return eventOf({ strike_type: cs.strike_type, floor_strike: cs.floor_strike, cap_strike: cs.cap_strike });
  }
  const f = num(m.floor_strike), c = num(m.cap_strike);
  switch (m.strike_type) {
    case "greater": return f == null ? null : { lo: f, loIn: false, hi: Infinity, hiIn: false };
    case "greater_or_equal": return f == null ? null : { lo: f, loIn: true, hi: Infinity, hiIn: false };
    case "less": return c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: false };
    case "less_or_equal": return c == null ? null : { lo: -Infinity, loIn: false, hi: c, hiIn: true };
    case "between": return f == null || c == null || !(f <= c) ? null : { lo: f, loIn: true, hi: c, hiIn: true };
    default: return null;
  }
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Does every value in X lie in Y? Exact on the boundaries: at a shared
// endpoint, X may include it only if Y does. So a containment that would
// hinge on the settlement landing exactly on a strike is not an
// implication, which is what the plan asks for.
export function implies(x, y) {
  if (!x || !y) return false;
  const loOk = y.lo < x.lo || (y.lo === x.lo && (y.loIn || !x.loIn));
  const hiOk = y.hi > x.hi || (y.hi === x.hi && (y.hiIn || !x.hiIn));
  return loOk && hiOk;
}

// An event read back from JSON. JSON writes Infinity as null, and null
// compares as 0, so an unrevived "above X" reads as the empty range
// (X, 0) and implies nothing it should.
export function reviveEvent(ev) {
  if (!ev) return null;
  return { lo: ev.lo ?? -Infinity, loIn: !!ev.loIn, hi: ev.hi ?? Infinity, hiIn: !!ev.hiIn };
}

// Markets that settle on the same number: same index, same close.
export function groupKey(m) {
  const idx = settlementIndex(m.rules_primary);
  const close = Date.parse(m.close_time);
  return idx && Number.isFinite(close) ? `${idx}|${new Date(close).toISOString()}` : null;
}

// Every ordered (X, Y) in a group with X implying Y and X !== Y. An equal
// pair (the same strike listed in two series) appears in both orders,
// since either can be the one priced too high. Input: [{ ticker, ev }].
export function implicationPairs(members) {
  const out = [];
  for (const x of members) for (const y of members) {
    if (x.ticker !== y.ticker && implies(x.ev, y.ev)) out.push([x.ticker, y.ticker]);
  }
  return out;
}

export function seriesOfTicker(t) {
  return String(t).split("-")[0];
}

// ---- Scoring the tape (the plan's verdict) ----
//
// A print is { t (ms), side, price, count }: side is the side the taker
// BOUGHT and price is what that side cost (lib/m15Tape.js parseTrade).
// So a taker-NO print on X proves X's NO ask (1 - its YES bid) at that
// instant, and a taker-YES print on Y proves Y's YES ask. When X implies
// Y, NO on X plus YES on Y pays at least $1 whatever settles, and costs
//   noPrice(X) + yesPrice(Y) + both taker fees.
//
// contradictionCandidates lists every such pair of prints within
// maxWindowMs whose cost is under $1 after fees at the smaller print's
// size. Each print carries an id unique within the group, so allocate()
// can use a print's contracts once.
//
// members: [{ ticker, ev }]; tapes: Map ticker -> prints sorted by t;
// fee(price, contracts, ticker) -> dollars for one order.
export function contradictionCandidates(members, tapes, { maxWindowMs, fee }) {
  let id = 0;
  const legs = [];
  for (const m of members) {
    const prints = tapes.get(m.ticker) || [];
    const no = [], yes = [];
    for (const p of prints) (p.side === "no" ? no : yes).push({ ...p, id: id++ });
    if (no.length || yes.length) legs.push({ ticker: m.ticker, ev: m.ev, no, yes, yesT: yes.map(p => p.t) });
  }
  const out = [];
  for (const x of legs) {
    if (!x.no.length) continue;
    for (const y of legs) {
      if (y === x || !y.yes.length || !implies(x.ev, y.ev)) continue;
      for (const n of x.no) {
        let j = lowerBound(y.yesT, n.t - maxWindowMs);
        for (; j < y.yes.length && y.yes[j].t <= n.t + maxWindowMs; j++) {
          const q = y.yes[j];
          if (!(n.price + q.price < 1)) continue;
          const size = Math.min(n.count, q.count);
          const e = (size * (1 - n.price - q.price) - fee(n.price, size, x.ticker) - fee(q.price, size, y.ticker)) / size;
          if (e > 0) out.push({
            x: x.ticker, y: y.ticker, ix: n.id, iy: q.id, tX: n.t, tY: q.t,
            noPrice: n.price, yesPrice: q.price, cX: n.count, cY: q.count, e0: e,
          });
        }
      }
    }
  }
  return out;
}

// Greedy by edge per contract: the best contradiction takes its size
// first, and a print's contracts are never counted twice. Only candidates
// within windowMs take part. Each kept pair is re-priced at the size it
// actually got, with the fee rounded on that size, and dropped if the
// edge is gone.
export function allocate(cands, { windowMs, fee }) {
  const rem = new Map();
  const sel = cands.filter(c => Math.abs(c.tX - c.tY) <= windowMs).sort((a, b) => b.e0 - a.e0);
  const out = [];
  for (const c of sel) {
    const rx = rem.has(c.ix) ? rem.get(c.ix) : c.cX, ry = rem.has(c.iy) ? rem.get(c.iy) : c.cY;
    const size = Math.min(rx, ry);
    if (!(size > 0)) continue;
    const edge = size * (1 - c.noPrice - c.yesPrice) - fee(c.noPrice, size, c.x) - fee(c.yesPrice, size, c.y);
    if (!(edge > 0)) continue;
    rem.set(c.ix, rx - size); rem.set(c.iy, ry - size);
    out.push({ ...c, size, edge });
  }
  return out;
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}
