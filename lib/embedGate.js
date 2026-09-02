// Which Kalshi series are worth spending a vector on.
//
// Kalshi's econ catalogue is 14,760 markets against Polymarket's 342, so
// at most 342 Kalshi rows can EVER be paired and the rest are vectors
// bought to be compared against nothing. Each costs a flat ~4KB of
// pgvector — float arrays are high-entropy, so TOAST compresses them to
// nothing — which is the free tier filling with markets that cannot
// match.
//
// The rule is EVIDENCE, NOT TAXONOMY: a series is embedded in full the
// first time it is seen, and after that only if it has actually produced
// a pair. A series that had its chance and matched nothing stops
// consuming quota as it lists new strikes and periods.
//
// Taxonomy was tried first and is wrong. Excluding Kalshi's Financials
// category looks obvious — 10,772 markets of S&P, Treasury, Nasdaq and
// FX ladders — but KXIPOOPENAI and KXIPOANTHROPIC live there too and are
// 4 of the 21 econ pairs the site shows. The waste is also a LONG TAIL:
// ~1,050 series of roughly ten markets each, one per listed company,
// which no hand-written list can track.
//
// Skipping is not deleting. An already-embedded row keeps its vector,
// and the market is still fetched, stored and searchable — search reads
// titles, so nothing leaves the catalogue. The series simply stops being
// a MATCH candidate.

// Kalshi tickers are <SERIES>-<event>-<outcome> and start with a letter.
// Polymarket ids are numeric strings and have no series, which is what
// makes null the right answer for them rather than a parse failure.
export function seriesTickerOf(id) {
  const t = String(id ?? "");
  return /^[A-Z]/.test(t) && t.includes("-") ? t.split("-")[0] : null;
}

// proven: series that have produced at least one pair.
// tried:  series that already carry at least one vector.
export function buildSeriesGate({ pairKalshiIds = [], embeddedIds = [] } = {}) {
  const proven = new Set();
  for (const id of pairKalshiIds) {
    const s = seriesTickerOf(id);
    if (s) proven.add(s);
  }
  const tried = new Set();
  for (const id of embeddedIds) {
    const s = seriesTickerOf(id);
    if (s) tried.add(s);
  }
  return { proven, tried };
}

// True when this market may be embedded.
export function allowEmbed(id, gate) {
  const s = seriesTickerOf(id);
  // Polymarket is the SCARCE side — 342 econ markets against Kalshi's
  // 14,760 — so its vectors are what every pair is built against, and
  // are cheap besides. Never gated.
  if (!s) return true;
  if (gate.proven.has(s)) return true;
  // Never seen before: give it a full, genuine chance. Sampling a
  // fraction would risk missing the one strike in a ladder that has a
  // counterpart, which is the failure this whole file exists to avoid
  // trading storage for.
  if (!gate.tried.has(s)) return true;
  return false;
}
