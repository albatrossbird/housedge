// Card titles, cleaned once.
//
// Shared by /api/markets and /api/search for the same reason
// lib/sportsKeys.js is shared: a divergent copy would show one title on
// the grid and a different one in search results for the same market,
// and the reader has no way to tell which is the market's real name.

const REDUNDANT_SIDE =
  /^(?:above|below|over|under|more than|less than|greater than|at least|at most)\s+(\$?\s*-?[\d,]+(?:\.\d+)?)\s*(%|k|m|bn|billion|trillion|million)?\.?$/i;

export function cleanTitle(raw) {
  const t = String(raw || "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

  const parts = t.split(/\s+[\u2014\u2013-]\s+/);
  if (parts.length < 2) return t;

  const side = parts[parts.length - 1].trim();
  const question = parts.slice(0, -1).join(" \u2014 ").trim();

  // A label the question already states in full adds nothing. Kalshi
  // labels a candidate market with the candidate, so "Will Jon Ossoff
  // be the Democratic Presidential nominee in 2028? — Jon Ossoff" says
  // the name twice, on every one of 394 politics cards.
  //
  // Not on a MATCHUP, though. "Miami vs Washington (Aug 29) — Miami"
  // names both teams in the question, so there the label is the only
  // thing saying which side the price belongs to — dropping it is the
  // exact regression this function was tightened to stop. A question
  // naming one subject and a question naming two are different cases,
  // and "vs" is what separates them.
  const isMatchup = /\bv(?:s\.?|\.)\s/i.test(question);
  if (!isMatchup && side.length >= 3) {
    const escSide = side.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w])${escSide}([^\\w]|$)`, "i").test(question)) return question;
  }

  const m = side.match(REDUNDANT_SIDE);
  if (!m) return t;

  const number = m[1].replace(/[$\s,]/g, "");
  const unit = (m[2] || "").toLowerCase();
  if (!number) return t;

  // Whole-number match, so "2.0" cannot be satisfied by "2026".
  const esc = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statesNumber = new RegExp(`(?<![\\d.])${esc}(?![\\d])`).test(question.replace(/,/g, ""));
  if (!statesNumber) return t;

  // A unit on the label must also appear, or "700" alone could match a
  // question about a different quantity entirely.
  if (unit && !new RegExp(unit === "%" ? "%" : `\\b${unit}\\b`, "i").test(question)) return t;

  return question;
}
