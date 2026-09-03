// A Kalshi ticker is <SERIES>-<event>-<outcome>, so the series is
// recoverable from any id already in the database. Polymarket ids are
// numeric strings with no dash and no series, which is what makes null
// the right answer for them rather than a parse failure.
//
// THE SERIES IS NOT ALWAYS "KX"-PREFIXED, AND ASSUMING IT WAS FROZE 79
// SERIES OF POLITICS PRICES.
//
// Kalshi's newer series carry the prefix (KXHOUSERACE, KXPRESNOMD) but
// its older ones do not: HOUSENH1, SENATEAR, GOVPARTYOR, CONTROLS,
// RSENATESEATS and 74 more are live, paired, and on the site. /api/refresh
// derived its poll list through a `startsWith("KX")` test, so every one
// of them returned null, was never polled, and sat at whatever price the
// last discovery run wrote — 8.3 hours and climbing, while the job
// reported 1,743 rows refreshed and no failures.
//
// Shared rather than copied because the alarm that was supposed to catch
// this reads the same function: every non-KX ticker mapped to the SAME
// null, so a Set collapsed 79 broken series into one entry that looked
// like a single benign gap.
export function seriesTickerOf(id) {
  const t = String(id ?? "");
  return /^[A-Z]/.test(t) && t.includes("-") ? t.split("-")[0] : null;
}
