// Is the FREE NWS observation good enough to stand in for the paid
// source Kalshi settles on?
//
// Every daily temperature market resolves "according to The Weather
// Company". We record NWS, so a disagreement between Kalshi's price and
// our forecast has two possible causes and we cannot tell them apart:
// Kalshi is mispriced, or TWC and NWS simply differ.
//
// TWC's trial rejects free email domains, so the key is not immediately
// available — but the basis can be measured WITHOUT it, by comparing an
// NWS-derived daily max against Kalshi's own SETTLED RESULT. That is
// the same method used for Coinbase against BRTI and Yahoo against
// Pyth, and it answers the question that actually matters: can we trade
// on NWS, and if not, by how much are we wrong.
//
// TWC and NWS both ultimately read the same ASOS instrument at these
// airports. The basis is therefore not about measurement but about
// ROUNDING, the day boundary, and QC — which is why both are reported.

// The local calendar day is what a "daily high" means, and it is NOT
// UTC. A Sep 10 high in Los Angeles runs to 07:00Z on Sep 11; bucketing
// by UTC date would mix two days together at every station west of
// Greenwich and silently corrupt every comparison.
export const STATION_TZ = {
  KNYC: "America/New_York",   KBOS: "America/New_York",    KPHL: "America/New_York",
  KDCA: "America/New_York",   KMIA: "America/New_York",    KATL: "America/New_York",
  KTTN: "America/New_York",   KEWR: "America/New_York",    KSDF: "America/New_York",
  KMDW: "America/Chicago",    KORD: "America/Chicago",     KDFW: "America/Chicago",
  KAUS: "America/Chicago",    KMSP: "America/Chicago",     KIAH: "America/Chicago",
  KHOU: "America/Chicago",    KMSY: "America/Chicago",     KOKC: "America/Chicago",
  KSAT: "America/Chicago",    KDEN: "America/Denver",
  // Arizona does not observe DST, so America/Phoenix is NOT
  // America/Denver for half the year.
  KPHX: "America/Phoenix",
  KLAX: "America/Los_Angeles", KSEA: "America/Los_Angeles", KSFO: "America/Los_Angeles",
  KSAN: "America/Los_Angeles", KLAS: "America/Los_Angeles",
};

export const cToF = c => (c == null || !Number.isFinite(Number(c)) ? null : Number(c) * 9 / 5 + 32);

// The local calendar date of an instant, at a station.
export function localDate(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || !tz) return null;
  // en-CA formats as YYYY-MM-DD, which is what we compare against
  // Kalshi's target_date.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(t));
}

// Daily high and low in Fahrenheit, per local date.
//
// QC IS NOT DECORATION. NWS flags each reading, and a value marked "X"
// (failed validity) or "Q" (questionable) is one the agency itself does
// not stand behind. Including it would put a bad sensor spike into a
// daily maximum, which is exactly the shape of error that looks like a
// trading edge. Only V (validated), C (coarse pass) and untagged
// readings count, and the rejected count is reported rather than
// silently dropped.
const QC_OK = new Set(["V", "C", "S", "T", null, undefined, ""]);

export function dailyExtremes(observations, tz) {
  const byDate = new Map();
  let rejected = 0, noTemp = 0;
  for (const o of observations) {
    const p = o?.properties || o;
    const raw = p?.temperature?.value;
    const qc = p?.temperature?.qualityControl;
    if (raw == null) { noTemp++; continue; }
    if (!QC_OK.has(qc)) { rejected++; continue; }
    const d = localDate(p.timestamp, tz);
    if (!d) continue;
    const f = cToF(raw);
    if (f == null) continue;
    const cur = byDate.get(d) || { date: d, highF: -Infinity, lowF: Infinity, n: 0 };
    cur.highF = Math.max(cur.highF, f);
    cur.lowF = Math.min(cur.lowF, f);
    cur.n++;
    byDate.set(d, cur);
  }
  for (const v of byDate.values()) {
    if (!Number.isFinite(v.highF)) { v.highF = null; v.lowF = null; }
  }
  return { byDate, rejected, noTemp };
}

// Kalshi publishes whole-degree Fahrenheit thresholds, and NWS reports
// Celsius. The conversion lands between degrees far more often than
// not, so HOW it is rounded decides the answer on exactly the markets
// that are close enough to trade. Both readings are returned because
// the data, not the author, should pick.
export const roundings = f => (f == null ? {} : {
  raw: f,
  round: Math.round(f),
  floor: Math.floor(f),
});

// Does an observed value resolve the market YES?
//
// Returns null for a strike shape we do not recognise rather than
// guessing: a wrong guess here is a confidently wrong comparison, which
// is worse than an admitted gap.
export function resolves(observedF, { strike_type, floor_strike, cap_strike }) {
  if (observedF == null) return null;
  const lo = floor_strike == null ? null : Number(floor_strike);
  const hi = cap_strike == null ? null : Number(cap_strike);
  switch (String(strike_type || "").toLowerCase()) {
    case "greater":          return lo == null ? null : observedF > lo;
    case "greater_or_equal": return lo == null ? null : observedF >= lo;
    case "less":             return hi == null ? null : observedF < hi;
    case "less_or_equal":    return hi == null ? null : observedF <= hi;
    case "between":          return lo == null || hi == null ? null : observedF >= lo && observedF <= hi;
    default:                 return null;
  }
}

// How far the observation sat from the threshold it was tested against.
// A free proxy can only disagree NEAR the line, so the distribution of
// misses by margin is the finding — not one aggregate percentage.
export function marginF(observedF, { strike_type, floor_strike, cap_strike }) {
  if (observedF == null) return null;
  const lo = floor_strike == null ? null : Number(floor_strike);
  const hi = cap_strike == null ? null : Number(cap_strike);
  const t = String(strike_type || "").toLowerCase();
  if (t.startsWith("greater") && lo != null) return observedF - lo;
  if (t.startsWith("less") && hi != null) return hi - observedF;
  if (t === "between" && lo != null && hi != null) {
    return Math.min(observedF - lo, hi - observedF);
  }
  return null;
}
