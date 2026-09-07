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
//
// AND SOME MARKETS HAVE NO DASH AT ALL, BECAUSE THE MARKET IS THE
// SERIES. `KXTRUMPRESIGN` and `KXTRUMPREMOVE` are single-market series:
// /series/KXTRUMPRESIGN exists ("Trump resign") and
// /markets?series_ticker=KXTRUMPRESIGN returns one active market whose
// ticker is the same string. Requiring a dash returned null for both,
// so two paired, live, rendered markets could never be refreshed —
// the same freeze the KX-prefix assumption caused, two markets wide
// instead of seventy-nine series.
//
// Deriving the series from a dashless ticker is safe in the other
// direction too: if a multi-market series ticker were ever stored as a
// market id by mistake, this polls that series, finds no market with
// that id, and the row lands in `kalshiPairedMissed` — visible, and
// far better than silently unrefreshable.
export function seriesTickerOf(id) {
  const t = String(id ?? "");
  if (!/^[A-Z]/.test(t)) return null;   // numeric and lowercase ids are Polymarket's
  return t.includes("-") ? t.split("-")[0] : t;
}
