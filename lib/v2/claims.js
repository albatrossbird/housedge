// Structured resolution-claim extraction, shared by v1 matching
// (pages/api/embed.js) and the v2 schema layer.
//
// Extracted into lib/ so the two callers cannot drift: v1's matchonly and
// normal modes were separately duplicated for a while and a diagnostic
// added to one branch went missing in the other. Same failure mode would
// apply here, with worse consequences — v2 persists these values as
// columns, so an extractor that disagrees with the matcher writes wrong
// data rather than just reporting it.
//
// These functions are pure and have no Supabase/network dependency.

// ── Numeric/period signature extraction for scalar markets ──────
// Cosine similarity on threshold-style titles (GDP/CPI/Fed-rate
// buckets, price thresholds, etc.) is dominated by shared topic text
// - "above 3.0%" and "above 0.5%" on the same underlying event score
// nearly as high against each other as true duplicates do, because
// the one number that actually distinguishes them is a small fraction
// of the text. This extracts the comparison + value (or range) and
// the time period from a title where the phrasing is recognizable.
// A candidate pair is rejected only when BOTH sides have an
// extractable signature AND it disagrees - anything not recognized
// falls through to embedding score alone, so this doesn't need to
// understand every possible market's phrasing to be useful, and
// generalizes to new categories/platforms without per-market-type
// hardcoding the way a team-alias map would.
export function extractNumericClaim(title) {
  const t = (title || "").toLowerCase();

  let m = t.match(/between\s+(-?\d+(?:\.\d+)?)\s*%\s+and\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "range", low: parseFloat(m[1]), high: parseFloat(m[2]) };

  m = t.match(/(?:more than|greater than|above|over)\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "gt", value: parseFloat(m[1]) };

  m = t.match(/at least\s+(-?\d+(?:\.\d+)?)\s*%/) ||
      t.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:or higher|or more|\+)/);
  if (m) return { unit: "percent", op: "gte", value: parseFloat(m[1]) };

  // "less than or equal to" must be tried before "less than" so it
  // isn't cut short by the "or equal to" text in between.
  m = t.match(/(?:less than or equal to|less than|below|under)\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "lt", value: parseFloat(m[1]) };

  m = t.match(/\bbe\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "eq", value: parseFloat(m[1]) };

  // Bare integer count claims with no unit symbol, e.g. "5 or more
  // rate hikes", "no rate hikes", "4 Fed rate hikes" - kept as a
  // distinct unit from percent claims so a rate-level question never
  // gets treated as compatible with a hike-count question just
  // because neither matched the same pattern. These two measure
  // genuinely different things even when correlated.
  m = t.match(/\b(\d+)\s+or more\b/);
  if (m) return { unit: "count", op: "gte", value: parseFloat(m[1]) };

  m = t.match(/\b(\d+)\s+(?:or fewer|or less)\b/);
  if (m) return { unit: "count", op: "lte", value: parseFloat(m[1]) };

  m = t.match(/\bno\s+(?:\w+\s+){0,3}?(?:hikes?|cuts?|increases?|decreases?)\b/);
  if (m) return { unit: "count", op: "eq", value: 0 };

  m = t.match(/\b(\d+)\s+(?:\w+\s+){0,2}?(?:hikes?|cuts?)\b/);
  if (m) return { unit: "count", op: "eq", value: parseFloat(m[1]) };

  // "25 bps increase/decrease" - a distinct unit from percent-level
  // claims, so this alone is enough to block a mismatch even without
  // fully parsing direction/magnitude (a bps claim can never be
  // compatible with a percent claim, per the unit check below).
  m = t.match(/(\d+(?:\.\d+)?)\+?\s*bps/);
  if (m) return { unit: "bps", op: "eq", value: parseFloat(m[1]) };

  return null;
}

export function extractPeriod(title) {
  const t = (title || "").toUpperCase();
  let m = t.match(/\bQ([1-4])\s*(\d{4})\b/);
  if (m) return { quarter: parseInt(m[1], 10), year: parseInt(m[2], 10) };
  m = t.match(/\b(20\d{2})\b/);
  if (m) return { quarter: null, year: parseInt(m[1], 10) };
  return null;
}

const NUMERIC_EPS = 0.05; // float safety margin, not a fuzzy-match tolerance

export function numericClaimsCompatible(a, b) {
  if (!a || !b) return true; // nothing extractable on one side - don't block on it
  if (a.unit !== b.unit) return false; // e.g. a rate-level claim vs a hike-count claim
  if (a.op === "range" || b.op === "range") {
    return a.op === "range" && b.op === "range" &&
      Math.abs(a.low - b.low) < NUMERIC_EPS && Math.abs(a.high - b.high) < NUMERIC_EPS;
  }
  const group = op => (op === "gt" || op === "gte") ? "gte" : (op === "lt" || op === "lte") ? "lte" : op;
  if (group(a.op) !== group(b.op)) return false;
  return Math.abs(a.value - b.value) < NUMERIC_EPS;
}

export function periodsCompatible(a, b) {
  if (!a || !b) return true;
  if (a.year !== b.year) return false;
  if (a.quarter != null || b.quarter != null) return a.quarter === b.quarter;
  return true; // both annual-only, same year
}

// Kalshi's econ series (KXFED/KXCPI/KXGDP/KXRECESSION) are all US-only
// and never name a country in their titles, but Polymarket's broader
// macro dashboard covers many countries with near-identical phrasing
// and often the same numeric thresholds - "GDP growth at least 2.0%"
// reads almost the same whether it's the US or the Eurozone asking.
// This is a fact about this specific Kalshi series, not a general
// assumption, so it's scoped to sportTag === "econ" rather than baked
// into the general-purpose extractors above.
const NON_US_REGION_PATTERNS = [
  // Noun and adjective forms both - "Japanese GDP", "German inflation",
  // "British jobs report" are as common as "Japan"/"Germany"/"UK", and
  // \bjapan\b doesn't match "Japanese" (no word boundary between "n"
  // and "e").
  /\buk\b/, /\bbritish\b/, /\bunited kingdom\b/, /\beurozone\b/, /\beuropean union\b/, /\beuropean\b/,
  /\bgermany\b/, /\bgerman\b/, /\bjapan(?:ese)?\b/, /\bmexic(?:o|an)\b/, /\bchin(?:a|ese)\b/, /\bfrance\b/, /\bfrench\b/,
  /\bitaly\b/, /\bitalian\b/, /\bcanada\b/, /\bcanadian\b/, /\bworld\b/, /\bglobal\b/, /\bindia\b/, /\bindian\b/,
  /\bbrazil\b/, /\bbrazilian\b/, /\bsouth korea\b/, /\bkorean\b/, /\baustralia\b/, /\baustralian\b/,
  // Non-US central banks - the "interest rates" tag surfaces plenty of
  // these (ECB, BOE, ...) phrased without a country/region word at all
  // ("Will the ECB announce a 25 bps increase..."), so a country-name
  // check alone missed them.
  /\becb\b/, /\beuropean central bank\b/, /\bbank of england\b/, /\bboe\b/,
  /\bbank of japan\b/, /\bboj\b/, /\breserve bank of australia\b/, /\brba\b/,
  /\bbank of canada\b/, /\bboc\b/, /\bswiss national bank\b/, /\bsnb\b/,
  /\bpeople'?s bank of china\b/, /\bpboc\b/, /\breserve bank of india\b/,
  /\brbi\b/, /\bbank of korea\b/, /\bbok\b/,
];

export function mentionsNonUsRegion(title) {
  const t = (title || "").toLowerCase();
  return NON_US_REGION_PATTERNS.some(re => re.test(t));
}

export function scalarSignaturesCompatible(titleA, titleB, sportTag) {
  if (sportTag === "econ" && (mentionsNonUsRegion(titleA) || mentionsNonUsRegion(titleB))) {
    return false;
  }
  return numericClaimsCompatible(extractNumericClaim(titleA), extractNumericClaim(titleB)) &&
         periodsCompatible(extractPeriod(titleA), extractPeriod(titleB));
}

