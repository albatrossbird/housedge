// Reading the 15-minute price path back out of m15_quotes, for the
// analysis scripts (m15-calibrate, m15-backtest). One copy, because the
// read shape is what decides whether these scripts work at all.
//
// EACH MARKET'S OWN WINDOW, on observed_at. A market is quoted for its
// whole listed life, not its last fifteen minutes, so asking for every
// row of a batch of tickers and filtering on secs_to_close read far more
// than it kept — and died with 57014 once m15_quotes passed a few
// million rows (2026-09-30). Each ticker here is a range on the
// (ticker, observed_at) index, 20 tickers per request.
//
// Callers run one of these at a time. Two concurrent analysis runs over
// this table, overlapping the daily discovery job, are what slowed the
// whole database on 2026-09-30.

const CHUNK = 20;

// markets: [{ ticker, close: ms }]. fromSecs/toSecs: seconds BEFORE the
// close bounding the window (fromSecs > toSecs >= 0). extra: further
// PostgREST filters, e.g. a secs_to_close range.
export async function readQuoteWindows(readAll, markets, { fromSecs, toSecs = 0, select, extra = "" }) {
  const rows = [];
  const ms = markets.filter(m => Number.isFinite(m.close));
  for (let i = 0; i < ms.length; i += CHUNK) {
    const terms = ms.slice(i, i + CHUNK).map(m => {
      const from = new Date(m.close - (fromSecs + 5) * 1000).toISOString();
      const to = new Date(m.close - Math.max(0, toSecs - 5) * 1000).toISOString();
      // Quoted: a timestamp carries "." and ":", which PostgREST reserves inside or=().
      return `and(ticker.eq."${m.ticker}",observed_at.gte."${from}",observed_at.lte."${to}")`;
    }).join(",");
    rows.push(...await readAll("m15_quotes", select, `or=(${encodeURIComponent(terms)})${extra ? "&" + extra : ""}&`, "ticker", "id"));
  }
  return rows;
}
