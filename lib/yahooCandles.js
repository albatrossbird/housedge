// Minute bars for the commodity underlyings, free and unkeyed.
//
// WHY NOT PYTH, WHICH IS THE ACTUAL SETTLEMENT SOURCE. Pyth's Free tier
// is "No Pyth API access" — view-only through their Terminal. Starter
// at $500/mo is "access to all CRYPTO symbols", which does not include
// metals or oil, and is the one asset class where Coinbase already
// serves us for free and where Pyth is not Kalshi's settlement source
// anyway. Commodities start at Pro, $2,500/mo.
//
// So the same question applies as for BRTI: not "can we read the index"
// but "how wrong is a free proxy", measured against settled markets we
// already hold.
//
// SPOT VERSUS FUTURES IS A REAL DIFFERENCE AND PROBABLY AN IRRELEVANT
// ONE. Kalshi settles on Pyth GOLD, which is spot XAU/USD; GC=F is the
// COMEX future, and the two differ by carry. But these are UP/DOWN
// markets over fifteen minutes, and carry does not move in fifteen
// minutes — only the direction has to agree. That is a claim to
// measure, not to assume, which is what scripts/crypto-basis.mjs does.
//
// THE 7-DAY CAP. Yahoo serves at most ~7 days of 1-minute bars
// (measured: range=7d gives 9,878 bars, range=1mo returns nothing). So
// this cannot backfill to June. It CAN validate a proxy against ~670
// settled markets per series, and — unlike the Kalshi price path, which
// is gone the moment it is not recorded — the underlying has a
// seven-day grace period, so a missed run is recoverable.

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// Kalshi series -> the contract that stands in for its Pyth feed.
export const YAHOO_SYMBOLS = {
  KXGOLD15M:   { symbol: "GC=F", pyth: "Metal.XAU/USD",                 note: "COMEX gold future vs spot" },
  KXSILVER15M: { symbol: "SI=F", pyth: "Metal.XAG/USD",                 note: "COMEX silver future vs spot" },
  KXWTI15M:    { symbol: "CL=F", pyth: "Commodities.Index.PYTHOIL/USD", note: "NYMEX WTI future vs Pyth oil index" },
};

export async function yahooChart(symbol, { range = "7d", fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${BASE}/${encodeURIComponent(symbol)}?interval=1m&range=${range}`, {
    // Yahoo serves this endpoint to browsers; a default agent gets
    // rejected. This is an UNOFFICIAL api — fine for research, and not
    // something to ship a product feature on without a paid feed behind
    // it.
    headers: { "User-Agent": "Mozilla/5.0 (compatible; marketslap-research/1.0)" },
  });
  if (!r.ok) throw new Error(`yahoo ${r.status} ${symbol}`);
  return r.json();
}

// Same Map shape scripts/crypto-basis.mjs already indexes Coinbase into,
// so refPrice/predict/marginBps work unchanged on either source.
//
// Yahoo pads its quote arrays with NULL for minutes that did not trade.
// Number(null) is 0, and a fabricated $0 gold print would read as a
// catastrophic move rather than as missing data — so every field is
// checked, not coerced.
export function indexYahooChart(json) {
  const m = new Map();
  const res = json?.chart?.result?.[0];
  const ts = res?.timestamp;
  const q = res?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return m;
  for (let i = 0; i < ts.length; i++) {
    const time = Number(ts[i]);
    const low = q.low?.[i], high = q.high?.[i], open = q.open?.[i], close = q.close?.[i];
    if (![time, low, high, open, close].every(v => v != null && Number.isFinite(Number(v)))) continue;
    m.set(time, {
      time, low: Number(low), high: Number(high),
      open: Number(open), close: Number(close),
      volume: q.volume?.[i] == null ? null : Number(q.volume[i]),
    });
  }
  return m;
}
