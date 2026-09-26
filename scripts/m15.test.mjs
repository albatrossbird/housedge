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
  // SHAPED LIKE THE API, NOT LIKE THE CODE. This fixture used to carry
  // `yes_bid_size: null` — a key Kalshi does not send — so it agreed
  // with the recorder's wrong read and pinned the bug for weeks. These
  // are the field names a live KXBTC15M market returns (2026-09-26).
  yes_bid_size_fp: "394402.33", yes_ask_size_fp: "1207.00",
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
  eq(q.bid_size, 394402.33, "touch size read from yes_bid_size_fp, the key Kalshi actually sends");
  eq(q.ask_size, 1207, "and the ask side from yes_ask_size_fp");

  // An ABSENT size is null — unknown — never a coerced zero, which would
  // read as "nothing offered" and is a claim about the book.
  const { yes_bid_size_fp, yes_ask_size_fp, ...noSize } = LIVE;
  eq(toM15Quote(noSize, at).bid_size, null, "no size field at all -> null, not 0");

  // A zero the VENUE sends is a fact and is kept: an ask of 1.00 with
  // size 0.00 is Kalshi saying nothing is offered.
  eq(toM15Quote({ ...LIVE, yes_ask_size_fp: "0.00" }, at).ask_size, 0, "a venue-sent 0.00 stays 0");

  // The old unsuffixed key is a fallback only, never preferred over _fp.
  eq(toM15Quote({ ...noSize, yes_bid_size: "5" }, at).bid_size, 5, "unsuffixed key still read as a fallback");
  eq(toM15Quote({ ...LIVE, yes_bid_size: "5" }, at).bid_size, 394402.33, "but _fp wins when both are present");
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

// The source stamp, and the thing that makes it safe to add.
{
  const plain = toM15Quote(LIVE, Date.parse("2026-09-06T04:23:00Z"));
  eq("source" in plain, false,
     "no source supplied -> the KEY IS ABSENT, not null");
  // Why that matters: PostgREST rejects a bulk insert whose objects have
  // different key sets (PGRST102), and the recorder posts many rows in
  // one call. A null here would also write a row claiming an unknown
  // writer, where absent means the column was never in play.

  const stamped = toM15Quote(LIVE, Date.parse("2026-09-06T04:23:00Z"), "box");
  eq(stamped.source, "box", "a supplied source is carried");

  // Everything else must be untouched by the addition — this shapes the
  // one input that cannot be re-fetched.
  const { source, ...rest } = stamped;
  eq(rest, plain, "the stamp changes NOTHING else about the row");

  eq("source" in toM15Quote(LIVE, Date.now(), ""), false,
     "an empty source is absent, not an empty string");
}

console.log(bad ? `${bad} failing` : "m15: all cases pass");
process.exit(bad ? 1 : 0);
