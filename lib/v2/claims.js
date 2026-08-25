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

  // Dollar strikes. Crypto is the same scalar-bucket problem as econ
  // with "$" where econ has "%", and until this existed the gate was
  // blind to it: "XRP above $6.50" vs "XRP reach $6.00" and "Bitcoin
  // above $199,999.99" vs "Bitcoin reach $190,000" both scored >0.91
  // and both are different bets.
  //
  // Tried last so a title carrying both a percentage and a dollar
  // figure still reports the percentage, leaving econ behaviour
  // untouched.
  const usd = extractUsdStrike(t);
  if (usd) return usd;

  return null;
}

// "$6.00", "$100k", "$129,999.99", "$1.5m"
const USD_RE = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|b)?\b/;
const USD_MULT = { k: 1e3, m: 1e6, b: 1e9 };

// Which side of the strike the title is betting on. Kalshi says
// "above"/"below"; Polymarket says "reach"/"hit" and "dip to"/"drop
// to", which carry the same direction in different words. Getting this
// wrong pairs "XRP above $2.00" with "XRP dip to $2.00" — identical
// strike, opposite bet, and a similarity score of 0.919.
const USD_UP   = /\b(?:above|over|reach(?:es)?|hits?|exceeds?|at least|greater than|more than|surpass(?:es)?)\b/;
const USD_DOWN = /\b(?:below|under|dips? to|drops? to|falls? to|fall to|less than|down to)\b/;

export function extractUsdStrike(lowerTitle) {
  const t = String(lowerTitle || "").toLowerCase();
  const m = t.match(USD_RE);
  if (!m) return null;

  let value = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(value)) return null;
  if (m[2]) value *= USD_MULT[m[2]];

  // Kalshi writes the strike one cent below the round number it means
  // ("above $99,999.99" is the $100,000 market). Normalise so it
  // compares equal to Polymarket's "$100,000".
  const cents = Math.round(value * 100) % 100;
  if (cents === 99) value = Math.round(value * 100 + 1) / 100;

  // "Will BTC hit $50,000 before $100,000?" is a race between two
  // strikes, not a threshold on either. Give it its own unit so the
  // unit check keeps it away from every plain threshold market.
  if (/\bbefore\s+\$/.test(t)) return { unit: "usd_race", op: "eq", value };

  const down = USD_DOWN.test(t);
  const up   = USD_UP.test(t);
  if (down === up) return null; // neither or both: direction unclear, don't block on it

  return { unit: "usd", op: down ? "lte" : "gte", value };
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
  // Dollar strikes span $0.02 to $200,000, so NUMERIC_EPS — an absolute
  // margin sized for percentages — is meaningless here: it would call
  // "DOGE below $0.02" and "DOGE dip to $0.06" the same market. Strikes
  // are exact quantities, so compare them exactly, in cents to keep
  // float representation out of it.
  if (a.unit === "usd" || a.unit === "usd_race") {
    return Math.round(a.value * 100) === Math.round(b.value * 100);
  }
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
  if (!deadlinesCompatible(titleA, titleB)) return false;
  return numericClaimsCompatible(extractNumericClaim(titleA), extractNumericClaim(titleB)) &&
         periodsCompatible(extractPeriod(titleA), extractPeriod(titleB));
}

// ── Resolution deadline ─────────────────────────────────────────
// The numeric gate is inert on categories whose titles carry no
// percentage — politics and crypto — leaving embedding score alone to
// decide. That produced pairs like:
//
//   "Will Tempo launch a token before Jan 1, 2027?"
//   "Will Tempo launch a token by December 31, 2027?"          (0.962)
//
// which are a FULL YEAR apart and resolve differently, and:
//
//   "Bitcoin above $100,000 by Sep 1, 2026"
//   "Will Bitcoin hit $100k by September 30, 2026?"            (0.943)
//
// Near-identical text, different bet. Comparing deadlines is what
// separates them.
//
// The tolerance must be small but non-zero: "before Jan 1, 2027" and
// "before 2027" and "end of 2026" all denote the same boundary while
// parsing to dates one day apart, and every verified-correct politics
// pair depends on treating those as equal.
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

export function extractDeadline(title) {
  const t = String(title || "").toLowerCase();
  let m;

  // "by Sep 1, 2026" / "before Jan 1, 2027"
  m = t.match(/\b(?:by|before|on|at)\s+(?:the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) return { y: +m[3], mo: MONTHS[m[1]], d: +m[2] };

  // "end of 2026"
  m = t.match(/\bend of\s+(\d{4})/) || t.match(/\b(\d{4})\s+year[- ]end/);
  if (m) return { y: +m[1], mo: 12, d: 31 };

  // "by December 2027" (no day) — start of that month
  m = t.match(/\b(?:by|before|in)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/);
  if (m) return { y: +m[2], mo: MONTHS[m[1]], d: 1 };

  // "before 2027" / "by 2027" — the boundary, i.e. Jan 1.
  //
  // "by <year>" reads as the start of that year, not the end of it.
  // Kalshi's own side_label confirms it: "Will Satoshi move any Bitcoin
  // by 2027?" carries the label "Before 2027". Reading it as Dec 31
  // rejected that market against Polymarket's "in 2026", which is the
  // same bet.
  m = t.match(/\b(?:before|by)\s+(\d{4})\b/);
  if (m) return { y: +m[1], mo: 1, d: 1 };

  // "in 2026" — the whole year, so Dec 31. ("by the end of 2026" is
  // already caught by the "end of <year>" rule above.)
  m = t.match(/\bin\s+(\d{4})\b/);
  if (m) return { y: +m[1], mo: 12, d: 31 };

  return null;
}

const toDays = d => Math.floor(Date.UTC(d.y, d.mo - 1, d.d) / 86400000);

// Polymarket routinely drops the year: "Will MetaMask launch a token by
// June 30?". extractDeadline can't resolve that, and letting it fall
// through to embedding score paired it with Kalshi's "before Jan 1,
// 2027" at 0.907 — six months apart at best.
//
// The general rule is never to block on a missing signature, but a
// stated deadline we can see and cannot resolve is not a missing one:
// the title asserts a cutoff, and it is not the cutoff the other side
// names in full. Guessing the year would be the alternative, and on
// 2026-08-25 "by June 30" is as likely to mean 2027 as 2026.
const BARE_MONTH_DAY = /\b(?:by|before|on)\s+(?:the\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/;

export function hasUnresolvedDeadline(title) {
  const t = String(title || "").toLowerCase();
  return BARE_MONTH_DAY.test(t) && extractDeadline(t) === null;
}

export function deadlinesCompatible(titleA, titleB, toleranceDays = 3) {
  const a = extractDeadline(titleA);
  const b = extractDeadline(titleB);
  if (a && hasUnresolvedDeadline(titleB)) return false;
  if (b && hasUnresolvedDeadline(titleA)) return false;
  if (!a || !b) return true; // nothing stated on one side: don't block
  return Math.abs(toDays(a) - toDays(b)) <= toleranceDays;
}
