// Game identity for sports markets, derived from the identifiers both
// venues already publish rather than from their prose titles.
//
// Shared by pages/api/embed.js (which builds the pairs) and
// pages/api/markets.js (which resolves which Polymarket outcome a given
// Kalshi side refers to). Both need the same team-code vocabulary, and
// a divergent copy would mean the matcher pairs a game while the read
// path prices the wrong half of it — so this lives in one place, for
// the same reason lib/v2/claims.js does.

// Month codes used by both venues' identifiers: Kalshi tickers say
// 26AUG27, Polymarket slugs say 2026-08-27.
export const MONTH_MAP = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

// Kalshi code → Polymarket code. Deliberately codes, not team names:
// across the 2026 MLB slate the two venues agree on every code except
// these, so this replaces a 30-entry-per-league alias map of full names
// with the handful of genuine disagreements.
export const TEAM_CODE_ALIASES = {
  AZ:  "ARI",  // Arizona Diamondbacks
  ATH: "OAK",  // Athletics
  // NFL. Diffing all 32 codes on both venues turned up exactly two
  // disagreements, and the second is a trap: Polymarket writes the Rams
  // as "LA" but the Chargers as "LAC", so mapping LAR to "LAC" — or
  // assuming one rule covers both Los Angeles teams — pairs the wrong
  // club and prices the wrong half of the game.
  JAC: "JAX",  // Jacksonville Jaguars
  LAR: "LA",   // Los Angeles Rams (LAC, the Chargers, agrees already)
};

// ── Leagues where the team CODE cannot be the key ──────────────
//
// College football has 275 Kalshi codes against Polymarket's 283, and
// 178 of them DISAGREE — a hand-written alias map an order of magnitude
// larger than MLB's two entries, which would rot every time either
// venue renamed a school.
//
// Worse, it could not be correct at any size: Kalshi REUSES three codes
// for different schools, measured on the live slate —
//
//   CSU  -> Colorado St.  AND  Central State (OH) Marauders
//   KSU  -> Kansas St.    AND  Kentucky State Thorobreds
//   WEB  -> Weber St.     AND  Webber International Warriors
//
// A flat code map cannot say "KSU is Kansas State in this game and
// Kentucky State in that one", so it would key two different fixtures
// to the same game and pair the wrong teams. That is the failure this
// whole file exists to prevent.
//
// Both venues publish clean NAMES for these — Kalshi's `yes_sub_title`,
// Polymarket's `teams[].alias` (and its moneyline `outcomes`) — and
// names are unique on both sides. So these leagues key on the name and
// need no alias table at all.
export const NAME_KEYED_LEAGUES = new Set(["ncaaf"]);

// "Colorado St." / "Colorado State" / "Colorado State University" all
// have to land on one string, because the two venues abbreviate
// differently and neither is wrong.
export function teamNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\./g, " ")
    .replace(/\bst\b/g, "state")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(university|univ|the|of|at)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameGameKey(date, nameA, nameB) {
  const a = teamNameKey(nameA), b = teamNameKey(nameB);
  if (!a || !b || a === b) return null;
  return `${date}|${[a, b].sort().join("+")}`;
}

// Both Kalshi sides of one game share everything before the outcome
// suffix: KXNCAAFGAME-26SEP17SYRPITT-SYR and ...-PITT. A single market
// knows only its OWN team name, so the pair has to be regrouped by
// event before a two-name key can be built.
export function kalshiEventOf(ticker) {
  const parts = String(ticker || "").split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : null;
}

export function kalshiGameDate(ticker) {
  const parts = String(ticker || "").split("-");
  if (parts.length < 2) return null;
  const dm = parts[1].match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!dm || !MONTH_MAP[dm[2]]) return null;
  return `20${dm[1]}-${MONTH_MAP[dm[2]]}-${dm[3]}`;
}

// The date alone, for slugs whose team codes this file does not parse.
// CFB codes carry digits ("cfb-lcdbfc25-nwst-2026-08-27"), which the
// letters-only pattern in polyGameKey rejects outright — so a
// name-keyed league needs the date without needing the codes.
export function polyGameDate(slug) {
  const m = String(slug || "").match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

// Which outcome index a Kalshi side refers to, resolved by NAME.
//
// Exact where the keyword fallback guesses: on a name-keyed league both
// venues publish the same school name, so this is a lookup. Returns
// null rather than a best guess, so the caller can fall through instead
// of silently pricing the opponent's side.
export function outcomeIndexByName(sideLabel, outcomes) {
  const want = teamNameKey(sideLabel);
  if (!want || !Array.isArray(outcomes)) return null;
  const idx = outcomes.findIndex(o => teamNameKey(o) === want);
  return idx === -1 ? null : idx;
}

export function normalizeTeamCode(code) {
  const c = String(code || "").toUpperCase();
  return TEAM_CODE_ALIASES[c] || c;
}

function gameKeyOf(date, codeA, codeB) {
  const codes = [normalizeTeamCode(codeA), normalizeTeamCode(codeB)];
  if (!codes[0] || !codes[1] || codes[0] === codes[1]) return null;
  return `${date}|${codes.slice().sort().join("+")}`;
}

// "KXMLBGAME-26AUG271910MILNYM-NYM" → { key, date, side: "NYM" }
//
// The side suffix is what makes the concatenated team blob splittable:
// "MILNYM" minus the "NYM" outcome leaves "MIL". Without it there is no
// unambiguous split point between two variable-length codes.
// LEAGUES THAT PLAY WEEKLY, where a game key may be retried a day out.
//
// Kalshi dates an NFL game by its US EASTERN date; Polymarket dates the
// same game by its UTC one. Every afternoon kickoff agrees, and every
// PRIME-TIME kickoff does not — 8:15pm ET is 00:15 UTC the next day —
// so Thursday Night, Sunday Night and Monday Night Football were
// unjoinable as a class. Measured on the live slate: 7 of 32 NFL games,
// all of them +1 day, all with a UTC kickoff between 00:15 and 00:35,
// while all 25 that joined kick off between 17:00 and 20:25 UTC.
//
// THIS CANNOT BE A GLOBAL RULE, and the measurement is what says so.
// MLB joins 41 of 41 on the ticker date as it stands; rebuilding the
// key from Kalshi's own `occurrence_datetime` scores 39/41 and from
// `close_time - 48h` scores 23/41, so "fix the timezone properly"
// BREAKS games that work today. Polymarket's convention differs per
// league, which is a fact about their sports feeds, not something to
// derive.
//
// A one-day retry is only safe where a fixture cannot be adjacent to
// another meeting of the same two teams. NFL and college football play
// once a week; MLB, NBA and NHL play series on consecutive days, where
// +1 could pair Monday's game with Tuesday's. Hence a list, not a flag.
export const WEEKLY_LEAGUES = new Set(["nfl", "ncaaf"]);

// The next calendar day, as an ISO date. Written with Date.UTC rather
// than by adding 86400000 to a parsed local date, so it does not shift
// on the two days a year a local timezone changes offset.
export function nextIsoDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return d.toISOString().slice(0, 10);
}

// The same game key one day later. Returns null for a key it cannot
// read, so a caller can treat "no alternate" and "no match" alike.
export function nextDayGameKey(key) {
  const i = String(key || "").indexOf("|");
  if (i < 1) return null;
  const next = nextIsoDate(key.slice(0, i));
  return next ? next + key.slice(i) : null;
}

export function kalshiGameKey(ticker) {
  const parts = String(ticker || "").split("-");
  if (parts.length < 3) return null;

  const [, event, side] = parts;
  const dm = event.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!dm || !MONTH_MAP[dm[2]]) return null;

  const date = `20${dm[1]}-${MONTH_MAP[dm[2]]}-${dm[3]}`;
  // Drop the date and any HHMM start time that precedes the team codes.
  const blob = event.slice(dm[0].length).replace(/^\d{4}/, "");
  const other = blob.replace(side, "");
  if (!other || other === blob) return null; // side absent from the blob

  const key = gameKeyOf(date, side, other);
  return key ? { key, date, side: normalizeTeamCode(side) } : null;
}

// "mlb-mil-nym-2026-08-27"      (polymarket.com) → { key, date, codes }
// "aec-mlb-mil-nym-2026-08-27"  (polymarket.us)  → the same
//
// `codes` stays in slug order, which matters — see polyOutcomeIndex.
//
// The optional `aec-` is Polymarket US's game-market prefix. Without it
// here the regex sees an extra segment and returns null, so
// polyOutcomeIndex falls through to keyword matching and can pick the
// opposing team's price — which is how a US pair reported a 3.6c edge
// that did not exist. The prefix was being stripped in the matcher and
// nowhere else; handling it in this shared helper is the whole reason
// this file exists.
export function polyGameKey(slug) {
  const m = String(slug || "").match(/^(?:aec-)?[a-z]+-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const key = gameKeyOf(m[3], m[1], m[2]);
  if (!key) return null;
  return { key, date: m[3], codes: [normalizeTeamCode(m[1]), normalizeTeamCode(m[2])] };
}

// Which index of a Polymarket moneyline market's `outcomes` /
// `outcomePrices` corresponds to a given Kalshi side.
//
// Resolving this by keyword — matching the Kalshi side label against
// the outcome text — fails in both directions. "A's" contributes no
// token longer than two characters, so it matches nothing and silently
// falls back to outcome 0, which is the *opponent's* price; and "New
// York M" matches "New York Yankees" as readily as "New York Mets".
// Either way the card shows one team's Kalshi price beside the other
// team's Polymarket price, which reads as a large arbitrage.
//
// The slug carries the two teams in the same order as `outcomes` —
// verified across every 2026 fixture Polymarket lists — so the index is
// a lookup, not a guess.
export function polyOutcomeIndex(kalshiTicker, polySlug) {
  const k = kalshiGameKey(kalshiTicker);
  const p = polyGameKey(polySlug);
  if (!k || !p) return null;
  const idx = p.codes.indexOf(k.side);
  return idx === -1 ? null : idx;
}
