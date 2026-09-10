// Pyth Benchmarks — the settlement source for Kalshi's 15-minute
// metals and oil.
//
// VERIFIED AGAINST KALSHI'S OWN RULES, not guessed. KXGOLD15M settles
// on "the close price of the 1-minute Pyth GOLD candlestick",
// KXWTI15M on "the 1-minute Pyth PYTHOIL candlestick" — and Pyth
// publishes a feed literally called Commodities.Index.PYTHOIL/USD, so
// the mapping is a match rather than an inference.
//
// A SINGLE CANDLE CLOSE, NOT AN AVERAGE. This is the structural
// difference from the crypto family, which settles on a sixty-second
// mean of a CF Benchmarks index. One tick is far jumpier than a mean,
// which is the leading explanation for why gold and silver calibrate
// worse than BTC and ETH at ninety seconds out.
//
// /v1/price_feeds is open. Everything historical requires a key as of
// 2026-08-26 16:00 UTC — verified by probe, which returns 401.

const BASE = "https://benchmarks.pyth.network";

// Feed ids read from /v1/price_feeds on 2026-09-10 and matched to the
// symbol Kalshi names in its rules text.
export const PYTH_FEEDS = {
  GOLD:    { symbol: "Metal.XAU/USD",                 id: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", series: "KXGOLD15M" },
  SILVER:  { symbol: "Metal.XAG/USD",                 id: "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e", series: "KXSILVER15M" },
  PYTHOIL: { symbol: "Commodities.Index.PYTHOIL/USD", id: "67784f72e95ac01337edb7d7bd5bbd1c03669101b7068a620df228ed4e52ef14", series: "KXWTI15M" },
};

export class PythKeyMissing extends Error {}

// Pyth reports a price as an integer plus a base-10 exponent, e.g.
// { price: "265432100000", expo: -8 }. Number(price) alone is wrong by
// eight orders of magnitude — a silent, enormous error that would still
// produce a plausible-looking direction call.
export function scalePrice(p) {
  if (!p) return null;
  const n = Number(p.price), e = Number(p.expo);
  if (!Number.isFinite(n) || !Number.isFinite(e)) return null;
  return n * Math.pow(10, e);
}

export async function pythGet(path, { key = process.env.PYTH_API_KEY, fetchImpl = fetch } = {}) {
  if (!key) throw new PythKeyMissing("PYTH_API_KEY is not set");
  const r = await fetchImpl(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "marketslap/1.0" },
  });
  // A 401 means the KEY is wrong, not that the data is absent. Saying so
  // is the difference between "fix your credential" and a day spent
  // theorising about coverage.
  if (r.status === 401) throw new PythKeyMissing(`401 unauthorized — check PYTH_API_KEY`);
  if (!r.ok) throw new Error(`pyth ${r.status} ${path.slice(0, 60)} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// The price at a moment. `interval` is capped at 60 seconds by Pyth.
export async function priceAt(feedId, tSecs, opts = {}) {
  const j = await pythGet(`/v1/updates/price/${tSecs}?ids[]=${feedId}`, opts);
  const p = j?.parsed?.[0]?.price;
  return { price: scalePrice(p), publishTime: p?.publish_time ?? null, raw: p ?? null };
}
