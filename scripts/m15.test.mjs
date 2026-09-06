// Shaping for Kalshi's 15-minute markets, pinned against real payloads
// captured from the live exchange on 2026-09-06.
//
// Worth pinning because the recorder is the one job whose input cannot
// be re-fetched: a window mis-shaped today is a window lost, not a
// window to re-read.
import { toM15Row, toM15Quote, quoteChanged, M15_SUFFIX } from "../lib/m15.js";

let bad = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { bad++; console.error(`FAIL ${what}\n  got:  ${g}\n  want: ${w}`); }
};

// Verbatim from /markets?status=open&series_ticker=KXBTC15M.
const LIVE = {
  ticker: "KXBTC15M-26SEP060030-30", event_ticker: "KXBTC15M-26SEP060030",
  title: "BTC price up in next 15 mins?", yes_sub_title: "Target Price: $79,984.94",
  floor_strike: 79984.94, cap_strike: null,
  open_time: "2026-09-06T04:15:00Z", close_time: "2026-09-06T04:30:00Z",
  yes_bid_dollars: "0.0610", yes_ask_dollars: "0.0620",
  yes_bid_size: null, yes_ask_size: null,
  volume_fp: "1262229.05", open_interest_fp: "457616.67",
  last_price_dollars: "0.0640", result: "",
};
// The same market once settled.
const SETTLED = { ...LIVE, ticker: "KXBTC15M-26SEP060015-15", result: "no", last_price_dollars: "0.0010" };

{
  const r = toM15Row(LIVE, "KXBTC15M");
  eq(r.ticker, "KXBTC15M-26SEP060030-30", "ticker");
  eq(r.series, "KXBTC15M", "series");
  eq(r.strike, 79984.94, "strike comes from floor_strike");
  eq(r.volume, 1262229.05, "volume parsed from the _fp string");
  // KALSHI SENDS "" FOR AN UNSETTLED MARKET. Storing that in a column
  // that means an outcome would make every live window look like a
  // settled one with a blank result.
  eq(r.result, null, "a live market has no result, not an empty string");
}
{
  const r = toM15Row(SETTLED, "KXBTC15M");
  eq(r.result, "no", "a settled market carries its outcome");
  eq(r.last_price, 0.001, "last price in dollars");
}
{
  // The series is recoverable from the ticker when not passed, so a
  // market found by any route lands in the same row shape.
  eq(toM15Row(LIVE).series, "KXBTC15M", "series derived from the ticker");
  eq(toM15Row(null), null, "no market, no row");
  eq(toM15Row({}), null, "a market with no ticker is not a row");
}
{
  const at = Date.parse("2026-09-06T04:26:41Z");
  const q = toM15Quote(LIVE, at);
  eq(q.secs_to_close, 199, "seconds remaining, stored not derived");
  eq(q.yes_bid, 0.061, "bid");
  eq(q.yes_ask, 0.062, "ask");
  // Kalshi publishes NO depth on this family. Null means unknown; a
  // zero here would read as "nothing offered", which is a claim about
  // the book rather than about our data.
  eq(q.bid_size, null, "no depth published, so null rather than zero");
  eq(toM15Quote({ ...LIVE, close_time: null }, at), null, "no close time, no usable observation");
}
{
  const t0 = Date.parse("2026-09-06T04:26:41Z");
  const a = toM15Quote(LIVE, t0);
  eq(quoteChanged(null, a), true, "the first observation is always written");
  eq(quoteChanged(a, toM15Quote(LIVE, t0 + 1000)), false, "an unchanged book one second later is not written");
  eq(quoteChanged(a, { ...a, yes_ask: 0.07 }), true, "an ask move is written");
  eq(quoteChanged(a, { ...a, yes_bid: 0.06 }), true, "a bid move is written");
  eq(quoteChanged(a, { ...a, volume: 1262300 }), true, "a trade is written even at an unchanged touch");
  // HEARTBEAT. Without it a flat market and a stopped recorder produce
  // the same thing — nothing — which is the failure mode this whole
  // codebase keeps re-learning.
  eq(quoteChanged(a, toM15Quote(LIVE, t0 + 59000)), false, "under the heartbeat, still not written");
  eq(quoteChanged(a, toM15Quote(LIVE, t0 + 61000)), true, "past the heartbeat, written even unchanged");
}
{
  // Series discovery is by suffix, not a hand-written list: Kalshi has
  // been adding coins to this family, and a constant would go stale the
  // way KALSHI_SERIES did for crypto and politics.
  for (const t of ["KXBTC15M", "KXGOLD15M", "KXSILVER15M", "KXINX15M", "KXEURUSD15M"]) {
    eq(M15_SUFFIX.test(t), true, `${t} is a 15-minute series`);
  }
  for (const t of ["KXBTC", "KXBTCD", "KXBTCMAX150", "KXNFLGAME", "KXBTC15MX"]) {
    eq(M15_SUFFIX.test(t), false, `${t} is NOT a 15-minute series`);
  }
}

console.log(bad ? `${bad} failing` : "m15: all cases pass");
process.exit(bad ? 1 : 0);
