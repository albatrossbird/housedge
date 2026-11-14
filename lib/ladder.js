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
