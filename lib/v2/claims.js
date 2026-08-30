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
// Which way the counted change goes. "3 rate CUTS" and "3 rate HIKES"
// carry the same unit and the same number and are opposite bets:
// Kalshi enumerates cuts ("Will the Fed cut rates 1 times? - Exactly 1
// cut"), Polymarket enumerates hikes ("Will 1 Fed rate hike happen in
// 2026?"), they scored 0.833, and they paired once for every N from 0
// to 4 because unit and value both agreed.
//
// Recorded as a separate field rather than folded into the unit, so
// the usual rule still holds: a title whose direction cannot be read
// (both words present, or neither) reports none and is compared on
// unit and value alone rather than being blocked on our blind spot.
const DIR_UP   = /\b(?:hikes?|hiking|increases?|increasing|raises?|raising|rises?)\b/;
const DIR_DOWN = /\b(?:cuts?|cutting|decreases?|decreasing|lowers?|lowering|reductions?)\b/;

function changeDirection(lowerTitle) {
  const up = DIR_UP.test(lowerTitle), down = DIR_DOWN.test(lowerTitle);
  if (up === down) return null;
  return up ? "up" : "down";
}

export function extractNumericClaim(title) {
  const t = (title || "").toLowerCase();

  let m = t.match(/between\s+(-?\d+(?:\.\d+)?)\s*%\s+and\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "range", low: parseFloat(m[1]), high: parseFloat(m[2]) };

  // Kalshi writes the same bucket as a bare span in its side label:
  // "GDP growth in 2026? - 2.6% to 3.0%". Without this it parsed to
  // nothing, so a bucket market compared against Polymarket's
  // "between 2.0% and 2.5%" had no signature to disagree with and
  // paired on score alone.
  m = t.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:to|through|[-\u2013\u2014])\s*(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "range", low: parseFloat(m[1]), high: parseFloat(m[2]) };

  m = t.match(/(?:more than|greater than|above|over|exceeds?)\s+(-?\d+(?:\.\d+)?)\s*%/);
  if (m) return { unit: "percent", op: "gt", value: parseFloat(m[1]) };

  // Kalshi's bucket labels put the number FIRST - "6.1% or Above",
  // "0.0% or Below" - so every pattern above, which expects the
  // comparator first, missed them and the label parsed to nothing.
  // That is how "6.1% or Above" paired with "greater than 2.5%".
  m = t.match(/at least\s+(-?\d+(?:\.\d+)?)\s*%/) ||
      t.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:or|and)\s+(?:higher|more|above|greater|over|up)/) ||
      t.match(/(-?\d+(?:\.\d+)?)\s*%\s*\+/);
  if (m) return { unit: "percent", op: "gte", value: parseFloat(m[1]) };

  m = t.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:or|and)\s+(?:lower|less|below|under|fewer)/);
  if (m) return { unit: "percent", op: "lte", value: parseFloat(m[1]) };

  // "Negative GDP growth in 2026?" states a threshold in words, the
  // same way "hit zero" does. Without it, teaching the extractor to
  // read Kalshi's "0.0% or Below" would have turned a verified-correct
  // pair into an asymmetry rejection - one side newly parsed, the
  // other still blind.
  m = t.match(/\bnegative\s+(?:\w+\s+){0,2}?growth\b/);
  if (m) return { unit: "percent", op: "lt", value: 0 };

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
  // "Will rates hit zero in 2026?" states a LEVEL of 0%, spelled out,
  // and so parsed to nothing at all - which let it pair with
  // Polymarket's "Fed Rate Cut in 2026?" (0.869), a market about
  // whether any cut happens. Reading the level is what makes the
  // strike-presence rule fire against a title that names no number.
  m = t.match(/\b(?:hits?|hit|reach(?:es)?|falls? to|goes? to|drops? to|to|at)\s+zero\b/) ||
      t.match(/\bzero\s+(?:percent|rates?|interest)\b/);
  if (m) return { unit: "percent", op: "eq", value: 0 };

  m = t.match(/\b(\d+)\s+or more\b/);
  if (m) return { unit: "count", op: "gte", value: parseFloat(m[1]), dir: changeDirection(t) };

  m = t.match(/\b(\d+)\s+(?:or fewer|or less)\b/);
  if (m) return { unit: "count", op: "lte", value: parseFloat(m[1]), dir: changeDirection(t) };

  m = t.match(/\bno\s+(?:\w+\s+){0,3}?(?:hikes?|cuts?|increases?|decreases?)\b/);
  if (m) return { unit: "count", op: "eq", value: 0, dir: changeDirection(t) };

  m = t.match(/\b(\d+)\s+(?:\w+\s+){0,2}?(?:hikes?|cuts?)\b/);
  if (m) return { unit: "count", op: "eq", value: parseFloat(m[1]), dir: changeDirection(t) };

  // "25 bps increase/decrease" - a distinct unit from percent-level
  // claims, so this alone is enough to block a mismatch even without
  // fully parsing direction/magnitude (a bps claim can never be
  // compatible with a percent claim, per the unit check below).
  m = t.match(/(\d+(?:\.\d+)?)\+?\s*bps/);
  if (m) return { unit: "bps", op: "eq", value: parseFloat(m[1]), dir: changeDirection(t) };

  // Large bare quantities: "Above 1.7 million total deliveries" against
  // "Tesla Q3 Total Deliveries? — Above 500k". Neither side parsed, so
  // the gate had nothing to disagree with and five annual-vs-quarterly
  // Tesla pairs went through on score alone — 1.7 million contracts
  // compared against 500 thousand.
  //
  // Deliberately narrow. It fires only with a magnitude word or on a
  // value of 1,000 or more, so it can never collide with a percentage
  // stated in words, and it skips anything denominated in dollars: a
  // "$" is already handled as a strike below, and "1500 billion
  // DOLLARS" is a strike written the long way. Reading that as a
  // count would give it a unit its counterparty could never match,
  // turning a working pair into a rejection.
  m = t.match(/(?:more than|greater than|above|over|exceeds?|at least)\s+(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn|b|thousand|million|billion|trillion)?\b/);
  if (m) {
    const before = t.slice(0, m.index + m[0].indexOf(m[1]));
    const after = t.slice(m.index + m[0].length);
    // A trailing "dollars" makes this a strike written the long way,
    // not a count, and a trailing "%" makes it a percentage. Both are
    // read by their own rules; a magnitude word alone is not enough to
    // tell them apart, and a negative lookahead is not either — the
    // engine simply backtracks past the magnitude word and matches the
    // bare number, which would read "1500 billion dollars" as 1500.
    if (!/\$\s*$/.test(before) && !/^\s*(?:dollars?|usd|%|percent)\b/.test(after)) {
      const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, trillion: 1e12 };
      const value = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? mult[m[2]] : 1);
      if (isFinite(value) && (m[2] || value >= 1000)) return { unit: "quantity", op: "gte", value };
    }
  }

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

// "$6.00", "$100k", "$129,999.99", "$1.5m", "$700 billion", "$1.5T"
//
// The magnitude has to be read spelled out as well as abbreviated:
// Kalshi writes "above $700 billion" where polymarket.us writes
// "Above $700 B", and reading only the attached letter made those 700
// and 700,000,000,000 — the same strike, compared as different markets.
const USD_RE = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|bn|b|t|thousand|million|billion|trillion)?\b/;
const USD_MULT = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

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
  if (a.dir && b.dir && a.dir !== b.dir) return false; // N cuts vs N hikes
  if (a.op === "range" || b.op === "range") {
    if (a.op !== "range" || b.op !== "range") return false;
    // Kalshi labels a bucket by its first included value, one tick
    // above the boundary - "1.1% to 1.5%" is the (1.0, 1.5] bucket
    // Polymarket writes as "between 1.0% and 1.5%". Same bucket, low
    // edges 0.1 apart, so the low edge gets one tick of slack while
    // the high edge - which both venues state identically - stays
    // exact. That is what keeps 2.6-3.0 away from 2.0-2.5.
    return Math.abs(a.high - b.high) < NUMERIC_EPS &&
           Math.abs(a.low - b.low) <= 0.1 + NUMERIC_EPS;
  }
  const group = op => (op === "gt" || op === "gte") ? "gte" : (op === "lt" || op === "lte") ? "lte" : op;
  if (group(a.op) !== group(b.op)) return false;
  // Dollar strikes span $0.02 to $200,000, so NUMERIC_EPS — an absolute
  // margin sized for percentages — is meaningless here: it would call
  // "DOGE below $0.02" and "DOGE dip to $0.06" the same market. Strikes
  // are exact quantities, so compare them exactly, in cents to keep
  // float representation out of it.
  if (a.unit === "usd" || a.unit === "usd_race" || a.unit === "quantity") {
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
  // The list was written from whichever foreign markets happened to be
  // in the audit at the time, which is not the same as the set that
  // exists. "Bank of Russia Decision in September? - 25 bps Decrease"
  // was the ONLY wrong pair in the entire 0.80-0.83 band, purely
  // because Russia had never come up before.
  /\brussia(?:n)?\b/, /\bbank of russia\b/, /\bcbr\b/,
  /\bisrael(?:i)?\b/, /\bbank of israel\b/, /\bturkey\b/, /\bturkish\b/,
  /\bswitzerland\b/, /\bswiss\b/, /\bsweden\b/, /\bswedish\b/, /\briksbank\b/,
  /\bnorway\b/, /\bnorwegian\b/, /\bpoland\b/, /\bpolish\b/,
  /\bhungary\b/, /\bhungarian\b/, /\bczech\b/, /\bnew zealand\b/,
  /\bsouth africa(?:n)?\b/, /\bchile(?:an)?\b/, /\bcolombia(?:n)?\b/,
  /\bargentin(?:a|e)\b/, /\bperu(?:vian)?\b/, /\bnigeria(?:n)?\b/,
  /\begypt(?:ian)?\b/, /\bindonesia(?:n)?\b/, /\bphilippine(?:s)?\b/,
  /\bthailand\b/, /\bthai\b/, /\bvietnam(?:ese)?\b/, /\bsingapore(?:an)?\b/,
  /\btaiwan(?:ese)?\b/, /\bhong kong\b/, /\bireland\b/, /\birish\b/,
  /\bspain\b/, /\bspanish\b/, /\bportugal\b/, /\bportuguese\b/,
  /\bnetherlands\b/, /\bdutch\b/, /\bbelgium\b/, /\bbelgian\b/,
  /\baustria(?:n)?\b/, /\bdenmark\b/, /\bdanish\b/, /\bfinland\b/, /\bfinnish\b/,
];

export function mentionsNonUsRegion(title) {
  const t = (title || "").toLowerCase();
  return NON_US_REGION_PATTERNS.some(re => re.test(t));
}

// A market that names a strike and one that does not are not the same
// claim.
//
// "Will Bitcoin be above $200,000 in 2026?" and "Will Bitcoin have the
// best performance in 2026?" are both about Bitcoin in 2026 and score
// alike, but only one is a threshold. Every gate here reads a
// signature, so a title carrying none falls through them all and pairs
// with any strike on the same subject — which is why crypto's floor was
// pinned at 0.90 rather than the ~0.88 real matches need.
//
// Fires only when EXACTLY one side has a numeric claim: if neither does
// (politics, most event markets) the gate stays out of the way, and if
// both do the existing unit/value comparison decides.
// Any number that is not just a year — the signal that a title states a
// value these extractors failed to parse.
//
// The guard matters more than the rule. "Will the Fed funds rate upper
// bound exceed 4.25%..." carries a claim that extractNumericClaim did
// not recognise, and asymmetry alone would have rejected it against its
// own paraphrase. Absence of a PARSED claim is not absence of a claim;
// only a title with no value in it at all is really claim-free.
// Calendar coordinates are not values. Dropping only years left "Q3"
// and "December 31" reading as stated thresholds, so
// "US GDP Growth in Q3 2026?" and "What Will Elon's Net Worth Hit By
// December 31?" - neither of which names a number at all - both looked
// like titles carrying a value we had failed to parse, and the
// asymmetry rule waved them through against six different Kalshi
// thresholds each.
function hasUnparsedValue(title) {
  const stripped = String(title || "")
    .replace(/\b(19|20)\d{2}\b/g, "")                                  // 2026
    .replace(/\bq[1-4]\b/gi, "")                                        // Q3
    .replace(/\b(?:h[12]|fy)\b/gi, "")                                  // H1, FY
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, "")  // December 31
    .replace(/\b\d{1,2}\s*(?:st|nd|rd|th)\b/gi, "")                    // 31st
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "");             // 12/31
  return /\d/.test(stripped);
}

// A ranking question and an absolute one are different claims even when
// they share every other word.
//
//   "Which of these cryptocurrencies will have a POSITIVE RETURN in 2026?"
//   "Will Bitcoin have the BEST PERFORMANCE in 2026?"            (0.896)
//
// The first asks whether one asset clears zero; the second asks whether
// it beats every other. Neither states a strike, so claim asymmetry does
// not fire and score alone was letting them pair — which is what kept
// crypto's floor pinned even after the strike rule.
// "next" and "first" belong here with the superlatives: they mark an
// EXCLUSIVE race, where only one subject can satisfy the claim.
//
//   "Will Susie Wiles be the NEXT person to leave the Trump Cabinet?"
//   "Who Will Be Announced Out of Trump Admin in 2026? — Susie Wiles"
//
// Someone who leaves second resolves NO on the first and YES on the
// second, so the two prices differ for a structural reason. Note this
// is NOT true of every "Who will..." market: "Who will recognize
// Palestine? — Germany" is a set of independent claims, several of
// which can resolve Yes, and it pairs correctly with "Will Germany
// recognize Palestine". The ordinal is what makes a race a race.
const SUPERLATIVE = /\b(best|worst|highest|lowest|top|most|all[- ]time high|next|first)\b/i;

function rankingCompatible(titleA, titleB) {
  return SUPERLATIVE.test(String(titleA || "")) === SUPERLATIVE.test(String(titleB || ""));
}

function strikePresenceCompatible(claimA, claimB, titleA, titleB) {
  const hasA = claimA != null, hasB = claimB != null;
  if (hasA === hasB) return true;
  const bareTitle = hasA ? titleB : titleA;
  // The other side states a value we could not parse — fall through to
  // embedding score rather than rejecting on our own blind spot.
  return hasUnparsedValue(bareTitle);
}

// What the market actually measures. Every other gate here reads a
// number, a period or a deadline, so two econ markets that state none
// of those are separated by nothing at all:
//
//   "State of the economy at the end of 2026? - Slack / disinflation"
//   "Fed Rate Hike in 2026?"                                  (0.816)
//
// Same year, same subject area, no threshold on either side. One asks
// about the inflation regime, the other about a policy action.
//
// Compared as sets, and rejecting only when both sides name a metric
// and the sets are DISJOINT - a title mentioning both inflation and
// the Fed still matches either, and a title naming none (bond yields,
// anything this list has not met yet) blocks nothing.
const ECON_METRICS = [
  ["gdp",          /\bgdp\b|gross domestic product/],
  // Nominal GDP is a different series with a different number - it ran
  // roughly two points above real GDP through 2026, which is exactly
  // the gap that renders as free money. Kalshi says "current-dollar";
  // "GDP growth" unqualified means real, on both venues.
  ["gdp_nominal",  /current[- ]dollar|\bnominal gdp\b/],
  // Regime markets ask which qualitative state the economy lands in.
  // They name no threshold, period or deadline, so before this the only
  // thing between "State of the economy - Soft landing" and "Fed Rate
  // Hike in 2026?" (0.794) was the embedding score.
  ["regime",       /\bstate of the economy\b|\b(?:soft|hard) landing\b|\bstagflation\b|\bgoldilocks\b|\bslack\b/],
  ["inflation",    /\b(?:dis)?inflation\b|\bcpi\b|\bpce\b|consumer price/],
  ["fed_rate",     /\bfed(?:eral)?(?:\s+reserve)?\b[^.?]*\brates?\b|\brate (?:hike|cut|increase|decrease)|\bfed(?:eral)? funds\b|\binterest rates?\b|\bfomc\b/],
  ["unemployment", /\bunemployment\b|\bjobless\b|\bjobs report\b|\bpayrolls?\b|\bnonfarm\b|\blabor force\b/],
  // Survey and level indicators. "Will University of Michigan Consumer
  // Sentiment Index for 2026 go above 65.0?" states its threshold as a
  // bare index level with no unit, so the numeric extractor reads
  // nothing and the strike-presence guard correctly declines to reject
  // on a value it can see but cannot parse. The metric is what
  // separates it from "US GDP growth greater than 2.5%" (0.782).
  ["sentiment",    /\bconsumer sentiment\b|\bconsumer confidence\b|\bumich\b|university of michigan/],
  ["housing",      /\bhome prices?\b|\bhousing starts?\b|\bcase[- ]shiller\b|\bmortgage rate\b|\bexisting home\b/],
  ["energy",       /\bcrude\b|\boil price\b|\bwti\b|\bbrent\b|\bgasoline\b|\bnatural gas\b/],
  ["wages",        /\bwage growth\b|\baverage hourly earnings\b|\bminimum wage\b/],
  ["retail",       /\bretail sales\b|\bconsumer spending\b/],
  ["trade",        /\btrade (?:deficit|balance|surplus)\b/],
  ["fx",           /\bexchange rate\b|\bdollar index\b|\busd\/|\byuan\b|\byen\b|\bpeso\b/],
  ["yields",       /\btreasury (?:yield|bill|note)\b|\bbond yield\b|\b10[- ]year yield\b/],
  ["recession",    /\brecession\b/],
  ["net_worth",    /\bnet worth\b/],
  ["debt",         /\bnational debt\b|\bdebt ceiling\b/],
  ["equities",     /\bs&p\b|\bnasdaq\b|\bdow jones\b|\bstock market\b/],
  ["tariff",       /\btariffs?\b/],
];

export function econMetrics(title) {
  const t = String(title || "").toLowerCase();
  const found = ECON_METRICS.filter(([, re]) => re.test(t)).map(([name]) => name);
  // "current-dollar gross domestic product" matches both patterns. It
  // is the nominal series and nothing else, so the generic tag has to
  // go or the sets would still intersect and the gate would not fire.
  return found.includes("gdp_nominal") ? found.filter(m => m !== "gdp") : found;
}

function metricsCompatible(titleA, titleB) {
  const a = econMetrics(titleA), b = econMetrics(titleB);
  if (!a.length || !b.length) return true;
  return a.some(m => b.includes(m));
}

// Touch or terminal: does the strike have to be reached AT ANY POINT,
// or held AT a stated moment?
//
// Kalshi runs both shapes on the same coin, same strike, same date, and
// their own rules_primary is what separates them:
//
//   KXBTCMAX150  "above $149,999.99 BY Dec 31"  -> "if the price is
//                above X by <date>"          — touch, at any point
//   KXBTCY       "BTC price ON Jan 1, 2027"   -> "if the average of the
//                sixty seconds before 12 AM EST is above X AT 12 AM EST"
//                                            — terminal, at a moment
//
// Polymarket US's "When will Bitcoin hit $150k? — Before January 2027"
// is a touch market, and it paired with the TERMINAL Kalshi one at
// 0.920 — while Kalshi's actual touch counterpart sat unpaired. A touch
// market is always at least as likely to resolve Yes as its terminal
// twin, so the two quote genuinely different prices and pairing them
// manufactures an edge that cannot be taken.
//
// Deliberately narrow on both sides: a false rejection here costs a
// correct pair, so each pattern names a phrasing actually observed on
// one of the three venues rather than guessing at the space.
const MONTH_ALT = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

// Touch: the strike has to be reached at some point in a window.
const TOUCH_RE = new RegExp(
  "\\bwhen will\\b" +
  "|\\b(?:hits?|reach(?:es)?|cross(?:es)?|touch(?:es)?)\\b" +
  "|\\b(?:dips?|drops?|falls?) to\\b" +
  "|\\bhow (?:high|low)\\b" +
  "|\\b(?:above|below|hit)\\b[^?]*\\bby\\b",
  "i"
);

// Terminal: the quantity is read AT a stated moment. Keyed on the
// preposition rather than on the word "price" - Kalshi writes "Will
// Elon Musk's net worth ON December 31, 2026 be above $2.0 trillion?",
// which the narrower pattern missed, and it paired with Polymarket's
// "What Will Elon's Net Worth HIT BY December 31?" - a touch market.
const TERMINAL_RE = new RegExp(
  "\\b(?:on|for)\\s+(?:the\\s+)?(?:" + MONTH_ALT + ")[a-z]*\\.?\\s+\\d{1,2}\\b" +
  "|\\bprice\\s+(?:at|on)\\s+the\\s+end\\s+of\\b" +
  "|\\bprice\\s+range\\s+eoy\\b",
  "i"
);

export function settlementStyle(title) {
  const t = String(title || "");
  // TOUCH WINS when both read. Kalshi states the window's end as a
  // moment - "above $6.00 by 11:59 PM ET ON Dec 31, 2026" carries both
  // markers - and letting the moment decide called five correct XRP
  // touch pairs terminal. The verb is what settles it: a title saying
  // "reach", "hit" or "above ... by" is describing a window, whatever
  // date follows.
  if (TOUCH_RE.test(t)) return "touch";
  if (TERMINAL_RE.test(t)) return "terminal";
  return null;
}

function settlementCompatible(titleA, titleB) {
  const a = settlementStyle(titleA), b = settlementStyle(titleB);
  if (!a || !b) return true; // unreadable on one side: don't block
  return a === b;
}

// ── Politics: what act, and to whom ─────────────────────────────
//
// Politics carries no threshold, no period and no strike, so every gate
// above is inert on it and the floor was doing all the work at 0.94.
// That is far too high for polymarket.us, whose titles are headlines
// ("Kash Patel Announced Out as FBI Director?") against Kalshi's full
// questions, and the same claim scores five to eight points lower for
// phrasing alone. At 0.94 the category matched 14 pairs, all
// polymarket.com; at 0.86 there are 95 candidates and roughly half are
// right.
//
// The wrong half falls into exactly two shapes, and both are gateable.

// 1. Same person, different act. "Will Gavin Newsom be ARRESTED before
//    Jan 2027?" against "Will Gavin Newsom ANNOUNCE a Presidential run
//    before 2027?" scored 0.882 — the subject carries the similarity and
//    the verb, which is the entire claim, carries none of it.
const POLITICAL_ACTS = [
  ["pardon",      /\bpardon(?:s|ed|ing)?\b|\bclemency\b|\bcommut(?:e|es|ed|ation)\b/],
  ["charge",      /\bcharged\b|\bindict(?:ed|ment)?\b|\bprosecut(?:e|ed|ion)\b|\bconvict(?:ed|ion)\b/],
  ["arrest",      /\barrest(?:ed)?\b|\bin jail\b|\bimprison(?:ed)?\b|\bdetain(?:ed)?\b/],
  ["leave_office",/\bleaves?\b|\bleave\b|\bout as\b|\bstep(?:s|ping)? down\b|\bresign(?:s|ed|ation)?\b|\bdepart(?:ure|s)?\b|\bousted\b|\bfired\b/],
  ["impeach",     /\bimpeach(?:ed|ment)?\b/],
  ["announce_run",/\bannounce[sd]? (?:a |their )?(?:presidential |white house )?run\b|\bpresidential run\b|\bdeclare[sd]? (?:a )?candidacy\b|\bwho will run for\b|\brun for (?:the )?(?:president|us president|the presidency)\b/],
  ["win_election",/\bwin(?:s)?\b|\bwinner\b|\belection winner\b/],
  ["visit",       /\bvisits?\b|\btravels? to\b/],
  ["meet",        /\bmeets?\b|\bmeeting\b|\bsummit\b/],
  ["testify",     /\btestif(?:y|ies|ied)\b|\btestimony\b/],
  ["recognize",   /\brecogni[sz]e[sd]?\b|\brecognition\b/],
  ["normalize",   /\bnormali[sz]e[sd]?\b|\babraham accords\b/],
  ["acquire",     /\bbuys?\b|\bacquires?\b|\bpurchase[sd]?\b|\b51st state\b|\bannex(?:es|ed)?\b/],
  // Split by WHICH award. Lumping them together paired "Who will earn
  // the Presidential Medal of Freedom in 2026?" with "Will Elon Musk
  // win the Nobel Peace Prize in 2026?" at 0.878.
  ["award_nobel",  /\bnobel\b/],
  ["award_freedom",/\bmedal of freedom\b/],
  ["award_other",  /\bprize\b|\baward(?:ed)?\b|\boscar\b|\bemmy\b/],
  // A race has stages, and the venues do not always name the same one.
  // "Who will RUN FOR the Republican presidential nomination" is not
  // "Will X WIN the 2028 Republican presidential nomination"; "QUALIFY
  // FOR THE RUNOFF in the 2027 French presidential election" is not
  // winning it; "advance from the Alaska Governor PRIMARY" is not the
  // governorship; the "2028 Iowa Republican CAUCUS" is one state, not
  // the nomination; a presidential TICKET names two people where the
  // election names one; and "smallest MARGIN OF VICTORY" asks which
  // race is closest, not who wins it. All six scored 0.86-0.96 against
  // the outcome they are a stage of, because the subject and the
  // contest carry the similarity and the stage carries none of it.
  ["margin",       /\bmargin of victory\b|\bclosest (?:race|margin)\b/],
  ["advance",      /\bqualify(?:ing)? for\b|\brunoff\b|\badvance (?:from|to|past)\b|\bmake the runoff\b/],
  ["caucus",       /\bcaucus\b/],
  ["primary_race", /\bprimary\b/],
  // Winning a party's nomination is not winning the office. "Will Jamie
  // Dimon be the Democratic Presidential nominee in 2028?" against
  // "Will Jamie Dimon win the 2028 US Presidential Election?" scored
  // 0.940 — same person, same year, and one is a precondition of the
  // other, so the prices are genuinely different and the gap reads as
  // an edge. Both sides saying "nomination" still pairs, which is what
  // keeps the thirty-five verified 2028 nominee pairs.
  ["nomination_race", /\bnominat(?:ion|ed)\b|\bnominee\b/],
  ["coalition",    /\bpart of the (?:next )?government\b|\bjoin (?:the )?(?:next )?coalition\b/],
  ["hold_office",  /\bbe the next\b|\bbe the (?:de facto )?(?:head of state|leader)\b/],
  ["ticket",       /\bpresidential ticket\b|\bvice[- ]presidential ticket\b/],
  // "Who will be named in Epstein documents" carried no act at all, so
  // it fell through to "Who will be arrested in 2026?".
  ["named",        /\bnamed in\b|\bappears? in\b|\breleased in\b|\bdocuments?\b|\bfiles\b/],
  ["nuclear",     /\bnuclear (?:test|weapon)\b/],
];

// A stage word wins over the outcome word it contains. "Who will RUN
// FOR the Republican presidential NOMINATION" matches both patterns,
// and if both survive the sets intersect and the gate passes the very
// pair it was added to reject. Same shape as gdp_nominal dropping the
// generic gdp tag.
// Which stage word suppresses which outcome word. A flat "stage beats
// win_election" list is not enough: once "nomination" moved out of
// win_election, "Who will RUN FOR the Republican presidential
// NOMINATION" and "Will X WIN the 2028 Republican presidential
// NOMINATION" both kept nomination_race, their act sets intersected,
// and the forty-two pairs this was added to reject came straight back.
// Declaring a run is a stage before the nomination, which is a stage
// before the election, so the order has to be stated.
const ACT_DOMINATES = {
  margin:          ["win_election", "nomination_race", "primary_race"],
  announce_run:    ["win_election", "nomination_race", "primary_race"],
  advance:         ["win_election", "nomination_race"],
  caucus:          ["win_election", "nomination_race"],
  ticket:          ["win_election", "nomination_race"],
  coalition:       ["win_election", "nomination_race"],
  primary_race:    ["win_election"],
  nomination_race: ["win_election"],
};

export function politicalActs(title) {
  const t = String(title || "").toLowerCase();
  const acts = POLITICAL_ACTS.filter(([, re]) => re.test(t)).map(([name]) => name);
  const suppressed = new Set();
  for (const a of acts) for (const beaten of ACT_DOMINATES[a] || []) suppressed.add(beaten);
  const kept = acts.filter(a => !suppressed.has(a));
  return kept.length ? kept : acts;
}

function actsCompatible(titleA, titleB) {
  const a = politicalActs(titleA), b = politicalActs(titleB);
  if (!a.length || !b.length) return true; // unreadable on one side: don't block
  return a.some(x => b.includes(x));
}

// 2. Different person entirely. "Will Matt Borges receive a
//    presidential pardon" against "Will Trump pardon Antoine Massey"
//    scored 0.871: identical claim shape, identical deadline, different
//    subject. Same for Michael Cohen against Roger Stone.
//
// Capitalised multi-word names only, and Trump is excluded because he
// appears on nearly every one of these titles as the ACTOR rather than
// the subject ("Will TRUMP pardon X"), so counting him would make every
// pardon pair look like it shared a name.
// The leading question word must be excluded from the MATCH, not just
// filtered afterwards. "Will Gilad Erdan be the next Prime Minister of
// Israel?" matched as the single name "Will Gilad Erdan", which the
// stopword guard below then discarded — taking the real name with it.
// Every Polymarket title is phrased "Will <Name> ...", so the name gate
// was inert on that entire side of the category, and "Bruno Le Maire"
// paired with "François Baroin" at 0.906 for want of a subject to
// disagree about.
//
// Accented letters have to be in the class for the same reason: without
// them "François", "Mélenchon" and "Élisabeth" are not names either,
// which is most of a French presidential field.
const NAME_LEAD = /^(?:will|who|the|before|after|by|which|what|is|are|does|do|if|and|or|in|on|at|for|to|of|a|an|next|new)$/i;
const NAME_RE = /\b([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+(?:\s+(?:[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+|[A-Z]\.|de|van|von|bin))+)\b/g;
const NAME_STOPWORDS = new Set([
  "donald trump", "president trump", "trump administration", "white house",
  "united states", "the united states", "new york", "supreme court",
  "abraham accords", "north korea", "south korea", "saudi arabia",
  "presidential medal", "medal of freedom", "nobel peace", "nobel peace prize",
  "prime minister", "vice president", "secretary of state", "chief of staff",
]);

export function properNames(title) {
  const t = String(title || "").replace(/\*\*/g, "");
  const out = new Set();
  for (const m of t.matchAll(NAME_RE)) {
    let name = m[1].trim();
    // Drop leading question words the regex swallowed, then keep what
    // is left only if it is still a multi-word name.
    let parts = name.split(/\s+/);
    while (parts.length && NAME_LEAD.test(parts[0])) parts.shift();
    if (parts.length < 2) continue;
    name = parts.join(" ");
    const low = name.toLowerCase();
    if (NAME_STOPWORDS.has(low)) continue;
    if (/^(will|who|the|before|after|by)\b/i.test(name)) continue;
    if (low.includes("trump")) continue;
    out.add(low);
  }
  return [...out];
}

function namesCompatible(titleA, titleB) {
  const a = properNames(titleA), b = properNames(titleB);
  if (!a.length || !b.length) return true; // one side names nobody: don't block
  // A shared surname is enough - "Lee Jae Myung" and "Lee Jae-myung" are
  // the same person spelled two ways, and requiring a whole-string match
  // would reject every cross-venue transliteration.
  const tokens = x => new Set(x.flatMap(n => n.split(/[\s-]+/)).filter(w => w.length > 2));
  const ta = tokens(a), tb = tokens(b);
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}

// ── Politics: WHICH race ─────────────────────────────────────────
//
// The act and the name gates both read the subject of a claim. Neither
// reads the CONTEST, and once Kalshi's Elections category landed that
// was most of the category: 435 House races, 35 Senate races and 36
// governorships, each phrased almost identically and differing only in
// a district code or a state. "Will Republican win the House race for
// RI-02?" against "Will the Republican Party win the CT-02 House seat?"
// scored 0.955 — two different states — and "Senate race in
// Pennsylvania" against "PA-10 House seat" scored 0.883, a different
// chamber. This is the same bucket problem as the econ thresholds, in
// a vocabulary of places instead of numbers.

const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY",
};
const CODE_SET = new Set(Object.values(STATE_CODES));

// "NC-1" on Kalshi is "NC-01" on Polymarket, so the number is padded
// before comparing. Only real state codes count: an unanchored
// two-letter-dash-number pattern would read any hyphenated token.
export function districtCodes(title) {
  const out = new Set();
  for (const m of String(title || "").matchAll(/\b([A-Za-z]{2})-(\d{1,2})\b/g)) {
    const code = m[1].toUpperCase();
    if (CODE_SET.has(code)) out.add(`${code}-${String(+m[2]).padStart(2, "0")}`);
  }
  return [...out];
}

// West Virginia has to be tried before Virginia, and New York before
// York, so the names are matched longest-first.
const STATE_NAMES = Object.keys(STATE_CODES).sort((a, b) => b.length - a.length);

export function statesNamed(title) {
  const t = String(title || "").toLowerCase();
  const out = new Set();
  for (const name of STATE_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(t)) out.add(STATE_CODES[name]);
  }
  for (const d of districtCodes(title)) out.add(d.split("-")[0]);
  return [...out];
}

// Which office is being contested. "vice president" suppresses
// "president" because it contains it, the same way a stage word
// suppresses the outcome it contains.
export function officesNamed(title) {
  const t = String(title || "").toLowerCase();
  const out = new Set();
  if (/\bhouse (?:race|seat|of representatives)\b|\bhouse seats?\b|\bcongressional district\b/.test(t)) out.add("house");
  if (/\bsenate\b|\bsenator\b|\bsenatorial\b/.test(t)) out.add("senate");
  if (/\bgovernor(?:ship)?\b|\bgubernatorial\b/.test(t)) out.add("governor");
  if (/\bvice[- ]president/.test(t)) out.add("vp");
  else if (/\bpresident(?:ial|cy)?\b/.test(t)) out.add("president");
  if (/\bmayor(?:al)?\b/.test(t)) out.add("mayor");
  if (/\bprime minister\b/.test(t)) out.add("pm");
  return [...out];
}

// Polymarket runs "will ANOTHER party win this seat" alongside the
// named-party markets. It is the complement of the ones we do match,
// and it reads almost identically: "Will Republican win the House race
// for TX-34?" against "Will another party win the TX-34 House seat?"
// scored 0.897 and is close to the opposite bet.
export function partiesNamed(title) {
  const t = String(title || "").toLowerCase();
  const out = new Set();
  if (/\bdemocrat(?:ic|s|ics)?\b|\bdem\b/.test(t)) out.add("dem");
  if (/\brepublican(?:s)?\b|\bgop\b/.test(t)) out.add("rep");
  if (/\banother party\b|\bthird party\b|\bother party\b|\bindependent\b/.test(t)) out.add("other");
  return [...out];
}

// Polymarket anonymises candidates it has not named yet: "Will D win
// the NC-01 House seat?", "Will Candidate Q win the Alaska Senate
// race?", "Will Person AH win the 2027 French presidential election?",
// "Will Leader 32 be the leader of Venezuela". Those are placeholders,
// not people, and properNames cannot see them — it reads capitalised
// multi-word names, and a placeholder is neither. A Kalshi market
// naming a real person is not the same market as one whose subject is
// a blank.
const PLACEHOLDER_RE =
  /\bwill\s+(?:the\s+)?(?:candidate|person|leader|option|team)\s+[a-z0-9]{1,3}\b|\bwill\s+[a-z]\s+win\b|\bwill\s+other\s+(?:be|win)\b/i;

export function hasPlaceholderSubject(title) {
  return PLACEHOLDER_RE.test(String(title || ""));
}

// Kalshi sells the parlay as well as the leg: "Will Los Angeles Mayor
// be Nithya Raman wins AND California Governor be Xavier Becerra wins",
// "Kansas Governor winner be Democratic party and Kansas Senate winner
// be Democratic party — Democrats sweep". Those need two things to
// happen and are strictly less likely than either, so pairing one
// against a single-office market manufactures an edge the size of the
// second leg.
export function isCombination(title) {
  const t = String(title || "").toLowerCase();
  if (/\bsweep\b/.test(t)) return true;
  return officesNamed(title).length >= 2 && /\band\b/.test(t);
}

function raceCompatible(titleA, titleB) {
  const disjoint = (a, b) => a.length && b.length && !a.some(x => b.includes(x));

  // A district is the most specific thing either title states, so it is
  // checked before the state it implies.
  if (disjoint(districtCodes(titleA), districtCodes(titleB))) return false;
  if (disjoint(statesNamed(titleA), statesNamed(titleB))) return false;
  if (disjoint(officesNamed(titleA), officesNamed(titleB))) return false;
  if (disjoint(partiesNamed(titleA), partiesNamed(titleB))) return false;
  if (isCombination(titleA) !== isCombination(titleB)) return false;

  // Only reject when the OTHER side names someone real: two vague
  // titles still fall through, same as two undated ones.
  if (hasPlaceholderSubject(titleA) !== hasPlaceholderSubject(titleB)) {
    const named = hasPlaceholderSubject(titleA) ? titleB : titleA;
    if (properNames(named).length) return false;
  }
  return true;
}

export function scalarSignaturesCompatible(titleA, titleB, sportTag) {
  if (sportTag === "econ") {
    if (mentionsNonUsRegion(titleA) || mentionsNonUsRegion(titleB)) return false;
    if (!metricsCompatible(titleA, titleB)) return false;
  }
  if (!deadlinesCompatible(titleA, titleB)) return false;
  if (!settlementCompatible(titleA, titleB)) return false;

  if (sportTag === "politics") {
    if (!actsCompatible(titleA, titleB)) return false;
    if (!namesCompatible(titleA, titleB)) return false;
    if (!raceCompatible(titleA, titleB)) return false;
  }

  const claimA = extractNumericClaim(titleA);
  const claimB = extractNumericClaim(titleB);
  if (!strikePresenceCompatible(claimA, claimB, titleA, titleB)) return false;
  if (!rankingCompatible(titleA, titleB)) return false;

  return numericClaimsCompatible(claimA, claimB) &&
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
  // "for" belongs here: Kalshi writes "Will Elon Musk's net worth FOR
  // December 31, 2026 be above $500 billion?", a valuation date stated
  // like any other. Without it that title parsed to no deadline at all,
  // and paired against a Polymarket US market dated August 31.
  // The separator matters: polymarket.us builds a title as
  // "<question> — <bucket>" and the bucket is where the date lives, so
  // the preposition and its own date end up on opposite sides of an
  // em-dash ("OpenAI IPO Officially Confirmed By — June 30, 2027").
  // Requiring them adjacent read that as NO deadline at all, and a
  // missing signature never blocks — which is how ten IPO markets
  // paired a month off, Kalshi's "Before Jun 1" against Polymarket's
  // "By June 30". A later cutoff is strictly likelier to resolve Yes,
  // so that gap renders as free money.
  m = t.match(/\b(?:by|before|on|at|for)\s*(?:[—–-]\s*)?(?:the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) return { y: +m[3], mo: MONTHS[m[1]], d: +m[2] };

  // "end of 2026"
  m = t.match(/\bend of\s+(\d{4})/) || t.match(/\b(\d{4})\s+year[- ]end/);
  if (m) return { y: +m[1], mo: 12, d: 31 };

  // "by December 2027" (no day) — start of that month
  m = t.match(/\b(?:by|before|in)\s*(?:[—–-]\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/);
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
const BARE_MONTH_DAY = /\b(?:by|before|on|for)\s*(?:[—–-]\s*)?(?:the\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/;

// The month and day of a deadline whose YEAR is missing.
//
// Polymarket US drops the year constantly - "Elon Musk Net Worth on
// December 31?", "on August 31?" - and treating every one of those as
// simply unresolvable threw away the half of the date that IS stated.
// Two of those titles differ by four months; refusing to look at the
// month is what let a December market pair with an August one.
const BARE_MD_RE = /\b(?:by|before|on|for)\s*(?:[—–-]\s*)?(?:the\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/;

export function extractBareMonthDay(title) {
  const t = String(title || "").toLowerCase();
  if (extractDeadline(t)) return null; // fully resolved: not this case
  const m = t.match(BARE_MD_RE);
  return m ? { mo: MONTHS[m[1]], d: parseInt(m[2], 10) } : null;
}

// Circular day-of-year distance, so Dec 31 and Jan 1 read as one day
// apart rather than 364 - the boundary both venues describe from
// opposite sides.
const DAY_OF_YEAR = md => Math.floor(Date.UTC(2001, md.mo - 1, md.d) / 86400000);
function monthDayClose(a, b, toleranceDays) {
  const diff = Math.abs(DAY_OF_YEAR(a) - DAY_OF_YEAR(b));
  return Math.min(diff, 365 - diff) <= toleranceDays;
}

export function hasUnresolvedDeadline(title) {
  const t = String(title || "").toLowerCase();
  return BARE_MONTH_DAY.test(t) && extractDeadline(t) === null;
}

export function deadlinesCompatible(titleA, titleB, toleranceDays = 3) {
  const a = extractDeadline(titleA);
  const b = extractDeadline(titleB);

  // A year we cannot read does not make the month and day unreadable.
  // Comparing what IS stated rejects "on August 31" against "for
  // December 31, 2026" while still allowing "on December 31" through -
  // and the old blanket rule could do neither, because it treated both
  // the same way.
  const bareA = extractBareMonthDay(titleA);
  const bareB = extractBareMonthDay(titleB);
  if (a && bareB) return monthDayClose(a, bareB, toleranceDays);
  if (b && bareA) return monthDayClose(b, bareA, toleranceDays);
  if (bareA && bareB) return monthDayClose(bareA, bareB, toleranceDays);

  // A stated cutoff we can see but cannot resolve at all, against a side
  // that states its year in full.
  if (a && hasUnresolvedDeadline(titleB)) return false;
  if (b && hasUnresolvedDeadline(titleA)) return false;

  if (!a || !b) return true; // nothing stated on one side: don't block
  return Math.abs(toDays(a) - toDays(b)) <= toleranceDays;
}
