// The series a Kalshi ticker belongs to. Getting this wrong does not
// throw — it silently removes a series from the refresh poll list, and
// the market's price freezes at whatever the last discovery run wrote.
import { seriesTickerOf } from "../lib/kalshiTicker.js";

let failed = 0;
const check = (name, got, want) => {
  if (got !== want) { failed++; console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// THE REGRESSION. Every one of these is live, paired and rendered, and
// every one returned null under the old `startsWith("KX")` rule, so its
// series was never polled and its price never refreshed.
for (const [ticker, series] of [
  ["HOUSENH1-26-D", "HOUSENH1"],
  ["SENATEAR-28-R", "SENATEAR"],
  ["GOVPARTYOR-26-R", "GOVPARTYOR"],
  ["CONTROLS-2028-R", "CONTROLS"],
  ["RSENATESEATS-27-E57", "RSENATESEATS"],
  ["HOUSETX34-26-D", "HOUSETX34"],
]) check(`legacy ${ticker}`, seriesTickerOf(ticker), series);

// KX-prefixed series still work — the fix must not trade one for the other.
check("KXHOUSERACE", seriesTickerOf("KXHOUSERACE-LA06-26-R"), "KXHOUSERACE");
check("KXMLBGAME", seriesTickerOf("KXMLBGAME-26AUG271910MILNYM-NYM"), "KXMLBGAME");
check("KXBTCY", seriesTickerOf("KXBTCY-26DEC31-T99999.99"), "KXBTCY");

// POLYMARKET IDS MUST STILL BE NULL. They are numeric strings with no
// dash; returning a "series" for one would put a Polymarket id into the
// Kalshi poll list, where it can only produce a wasted request.
check("poly numeric", seriesTickerOf("516729"), null);
check("poly long numeric", seriesTickerOf("21742633143463906290569050155826241533067272736897614950488156847949938836455"), null);

// A ticker with no dash has no series to extract — a bare series name
// is not a market id.
check("no dash", seriesTickerOf("KXHOUSERACE"), null);
check("lowercase slug", seriesTickerOf("mlb-mil-nym-2026-08-27"), null);
check("empty", seriesTickerOf(""), null);
check("null", seriesTickerOf(null), null);
check("undefined", seriesTickerOf(undefined), null);

console.log(failed ? `${failed} failing` : "kalshi-ticker: all cases pass");
process.exit(failed ? 1 : 0);
