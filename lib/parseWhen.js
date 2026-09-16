// The watched tables do not agree on how they store a time, and
// assuming they did made this check red for a table that was one
// minute old.
//
// `m15_quotes.observed_at` and `wx_quotes.observed_at` are timestamps
// and parse as ISO strings. `markets.updated_at` is a Unix epoch
// INTEGER — the live value was 1789567876, which Date.parse turns into
// NaN because it stringifies the number and fails to read "1789567876"
// as a date. So the column that was genuinely fresh reported as
// unreadable.
//
// Seconds or milliseconds is decided by magnitude, not by hope: epoch
// SECONDS pass 1e11 in the year 5138, and epoch MILLISECONDS passed it
// in 1973, so the boundary is unambiguous for any time this project
// will ever see.
//
// THE SANITY WINDOW IS THE POINT. Reading seconds as milliseconds
// yields 1970, which is not an error — it is a valid date that renders
// as "489,000 hours stale" and sends the reader hunting a dead recorder
// that is fine. A unit mistake must report itself AS a unit mistake.
const EPOCH_MS_CUTOFF = 1e11;
const PLAUSIBLE_FROM = Date.parse("2020-01-01T00:00:00Z");
const PLAUSIBLE_TO   = Date.parse("2100-01-01T00:00:00Z");

export function parseWhen(raw) {
  if (raw == null || raw === "") return null;
  let t;
  const n = typeof raw === "number" ? raw : (/^\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : NaN);
  if (Number.isFinite(n)) t = n < EPOCH_MS_CUTOFF ? n * 1000 : n;
  else t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  // Outside the window it is a unit or format error, not a timestamp.
  if (t < PLAUSIBLE_FROM || t > PLAUSIBLE_TO) return null;
  return t;
}
