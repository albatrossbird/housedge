# Ladder consistency: plan, fixed before the run

Written 2026-11-13, before any data was read. Open task 1 in
`docs/research/brief.md`. Nothing below may change after the first read
except by a dated note saying what changed and why; a change made after
seeing results makes the result a candidate to re-test, not a finding.

## Question

Do Kalshi's crypto strike ladders (hourly and daily, plus any other
crypto market closing at the same moment on the same index) ever trade
at prices that contradict each other by more than the fees, often and
large enough to be worth building for?

## Hypothesis

- **H1 (the idea):** contradictions that lock in a profit after taker
  fees appear on the tape, at sizes that actually traded, worth at least
  $10 a day.
- **H0 (what I expect):** the ladders are quoted by market makers who
  keep them consistent; what contradictions exist are smaller than the
  two fees, or too thin to matter.

## What counts as a contradiction

Markets are grouped by **(settlement index, close time)**. Two markets
belong to one group only if their `rules_primary` names the same index
and the same averaging, and their close times are equal. This is how
hourly, daily and 15-minute markets that close at the same moment are
compared, without assuming any series name.

Each market's event is read from its structured strike fields
(`strike_type`, `floor_strike`, `cap_strike`), never from its title.

**Class 1, implication (the verdict).** Market X implies market Y when
every settlement value that resolves X Yes also resolves Y Yes,
boundaries included ("above 100,000" implies "above 99,500"; the bucket
"100,000 to 100,249.99" implies "above 99,999.99"). Then
P(X) <= P(Y), and if X's YES bid exceeds Y's YES ask, buying NO on X
and YES on Y pays at least $1 whatever happens. Strikes whose
containment depends on a tie at the boundary are left out.

**Class 2, partition sums (screen only).** Where a group's buckets
cover every value with no gap or overlap, the YES asks summing under $1
after fees (buy every bucket), or the YES bids summing over $1 after
fees (buy every NO).

## Data

All public Kalshi endpoints, no key, no box, no new recorder, no
Supabase, no Storage reads.

1. `/series?category=Crypto` to find the series; `/series/<ticker>` for
   `fee_type` and `fee_multiplier`, and
   `/series/fee_changes?series_ticker=&show_historical=true` for any
   change inside the window.
2. `/markets` (settled and open) for every market in those series that
   closed in the window: strike fields, close time, `rules_primary`,
   `volume`.
3. **The trade tape**, `/markets/trades` by ticker over each market's
   life: time to the microsecond, YES price, count, taker side.
4. **One-minute candles**, `/markets/candlesticks?market_tickers=`
   (10,000 candles a request): YES bid and ask at each minute's close.

**Window:** 14 UTC days, 2026-10-30 to 2026-11-12, all inside the live
tier.

**A size pass comes first.** Steps 1 and 2 only, then I report the
series found, market counts, total traded contracts and the number of
tape and candle requests the full read needs, at Kalshi's ~5 requests a
second per IP. No tape or candle read starts until that number has been
shown.

**Early stop on the size pass:** if all of these ladders together trade
under 1,000 contracts a day, $10 a day would need 1c of after-fee edge
on every contract traded, and the run stops there.

## How the tape is scored (the verdict)

- A taker-NO print on X at YES price p proves X's YES bid was p at that
  instant. A taker-YES print on Y at price q proves Y's ask was q.
- A **contradiction** is such a pair, X implying Y, printed within
  **1 second** of each other, with
  `(1 - p) + q + fee(1 - p) + fee(q) < $1`.
- **Size** is the smaller of the two prints. Each print's contracts are
  used once, assigned greedily by edge per contract, so one print cannot
  be counted against several partners.
- **Fees** are Kalshi's taker formula per leg, each leg its own order,
  rounded up to $0.0001 (a direct member, as the trader is), at the
  series' `fee_multiplier` for that date (`lib/fees.js`
  `kalshiTakerFee`). Maker fees are not used: both legs cross.
- **Edge in dollars** = size x (1 - both prices - both fees per
  contract), summed per UTC day.

Every figure is an upper bound: a print proves a price was there for
whoever took it, not that a second taker would have got it.

## Pass bar and stop rule

**Passes** only if both hold, at the 1-second window:
- the 14-day total is at least **$140** (an average $10 a day); and
- at least **7 of the 14 days** carry $5 or more, so one freak day
  cannot pass it.

**Otherwise stop.** Write it up in `docs/research/m15.md` with the run
id and do not record books.

Reported beside the verdict, not part of it:
- the same totals at 100ms and 5s windows, and at $0.01 fee rounding;
- per series, per class, by time to close, and by price;
- **how many contradicting pairs printed within 50ms of each other**.
  Two legs filled that close together are most likely one taker taking
  both, which says a faster bot is already there. If most are, that is
  an early answer to the co-location question;
- Class 2 and Class 1 from the candles: how often a minute's closing
  quotes contradict, with no size. This is the screen, never the
  verdict.

## If it passes

Record a few days of the contradicting groups' books (the full ladder
is on `/markets/<ticker>/orderbook`, or the WebSocket) to measure how
long each gap lasts. Stop if the median gap lasts under 50ms: only a
co-located bot gets those. That step gets its own written plan first.

## Note, 2026-11-14 (before any data was read)

Asked the session that wrote the brief where the $10 a day came from.
The answers, recorded so the bars are fixed before the run:

- **$10 a day is a round number, a screen, not a cost.** Below it,
  nothing is worth recording. Passing the tape step justifies step 2
  (recorded books) only, never a build. The tape bar above is unchanged:
  $140 over 14 days, with at least 7 of the 14 days at $5 or more.
- **It is a tape figure, an upper bound.** Assume a bot that is not
  co-located captures at most 20% of it until a recorded book shows
  otherwise. So $10 a day on the tape is about $2 a day captured.
- **Legging is not scored at the tape step**, since the tape cannot
  show it. At the recorded-book step: send both legs at our latency
  (+250ms, then +100ms), count a fill on one leg only as LEGGED, and
  price it both unwound at the bid and held to settlement, reporting
  both.
- **The bar to build is about $10 a day captured, after legging costs,
  across 2+ weeks.**
- **Gaps under ~50ms are a hard stop for research.** Co-location is a
  spending decision for the user. Report the figure and the gap
  lifetimes, but do not recommend it unless captured edge at co-located
  latency is about $100 a day or more, sustained out of sample.

## Where it runs

Its own script (`scripts/ladder-tape.mjs`, with the pure parts in
`lib/ladder.js` and a test against fixtures copied from live
responses), from this branch. It reads only Kalshi, so it can run from
this session if the sandbox reaches the Kalshi API, or else as a manual
workflow on the `m15-analysis` queue, one at a time with the other
analysis runs.
