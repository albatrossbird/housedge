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
};

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
