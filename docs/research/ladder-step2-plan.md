# Ladder consistency, step 2: recorded books. Plan, fixed before recording

Written 2026-11-14, before anything was recorded. Step 1 (the tape) is in
`ladder-plan.md` and in m15.md "Ladder consistency". Nothing below
changes after the first recorded hour except by a dated note saying what
changed and why.

## What step 1 left open

The tape passed by a wide margin, but a tape cannot say:
- **how long a contradiction lasts.** Two prints only prove two prices
  existed at two instants;
- **whether we would have filled.** A competing bot visibly takes both
  legs at the same millisecond, 200 and 200, every 100ms;
- **what a fill on one leg only costs.**

The recorded book answers all three. The bars below come from the brief
and the session that wrote it (`ladder-plan.md`, note of 2026-11-14).

## Hypothesis

- **H1:** contradictions on the Bitcoin hourly ladders last long enough
  for a bot at our latency to take both legs, and that bot would clear
  **$10 a day after legging costs**, sustained over 2+ weeks.
- **H0 (what I expect):** most gaps close inside 50ms, taken by the bot
  already there, and what is left at +100ms is mostly one-legged fills.

## Scope, from step 1

Step 1 found the edge on Bitcoin, in the final 15 minutes before each
hourly close (1-15m and under 1m: $44.3k of $48.2k). So the recording
covers only:
- **Markets:** at each hourly close, the KXBTC15M window closing then,
  plus the KXBTCD and KXBTC markets whose strike is within ±2.5% of
  that window's strike (the price 15 minutes before the close), capped
  at 80 markets. The 5pm daily ladder is the same series and is
  included at its close like any other hour.
- **When:** from 16 minutes before each close to the close, 24 times a
  day.
- **What:** every book change (full depth) and every trade, on ONE
  socket, so that every market in a close shares one sequence and one
  clock (Kalshi's `ts_ms`). Lifetimes are measured on Kalshi's clock,
  never on the box's.

**Scope check first, from the cached tape (no new reads):** re-score
step 1 at 100ms keeping only pairs inside this scope. If the scope keeps
under 80% of the 100ms edge, widen it before recording and note why.
ETH and the other coins are out of scope. Whatever step 2 finds, it
says nothing about them.

## Where it runs

- **A new recorder on the box**, `scripts/ladder-stream.mjs` with unit
  `marketslap-ladder-stream.service`. It reuses the stream recorder's
  parts: `lib/plainWebSocket.js`, `lib/kalshiAuth.js` with the
  read-only key through `LoadCredential`, `lib/kalshiBook.js` with
  `use_yes_price: true`, sequence-gap marking and the health lines. It
  runs beside `m15-stream`, not inside it, so a fault cannot cost the
  recorder the live research depends on.
- **Not enabled by bootstrap or the sync timer.** You start it on the
  box, after `scripts/kalshi-ws-probe.mjs` passes. Steps will go in
  `deploy/README.md`.
- **Archive:** hourly gzipped NDJSON in the private `stream-archive`
  bucket, folder `ladder/`. Same rules as every recording: never public,
  no read policy, never committed.
- **Not this sandbox.** It paused when idle and restarted once during
  step 1; a recorder cannot run here.

**Load stop (the recorder's own rule):** stop it and report if, in any
hour:
- `m15-stream`'s receive lag goes past its 5s warning; or
- the ladder recorder's own lag p99 passes 1s; or
- the box's free memory falls under 100MB.

The live research comes first.

## What is measured

All on recorded books, from Kalshi's timestamps.

**1. Gap lifetime.** For each implication pair (X implies Y, same close,
the step 1 rule in `lib/ladder.js`), a gap is open while
`X's best YES bid - Y's best YES ask - both taker fees > 0`, at one
contract. A **qualifying gap** has at least 1c per contract after fees
and at least 10 contracts at both touches when it opens. Recorded per
gap: open and close time, the largest edge, the touch sizes, and what
closed it: a trade on either leg (someone took it) or a quote moving
(a maker fixed it). Gaps open during a sequence gap or an untrusted
book are dropped and counted.

**2. Capture at our latency.** At each qualifying gap's open (t0), both
legs are sent as limit orders at the prices seen at t0 and fill
immediately or not at all, at a size of 40 contracts (the trader's
size; 10 is also reported). Each leg fills at t0 + L against the book
as it stood then: up to the depth at that price or better, capped at
40. L = **+250ms** (the trader's current p90 bar) and **+100ms** (the
median bar), plus +50, +25 and +0 as figures only.
- **Both legs fill:** the matched size is locked in. Profit = size x
  (1 - both prices) - both fees.
- **One leg fills more than the other: LEGGED.** The excess is priced
  two ways, and both are reported:
  - **unwound:** sold back at the bid at t0 + 2L, paying a second
    taker fee;
  - **held:** held to settlement, on the market's result.
- Fees are Kalshi's taker formula per order, rounded to $0.0001.

It stays an upper bound. When we and the competing bot arrive at the
same instant, the replay gives us the fill.

## Stop rules and bars

1. **Early stop, after 3 recorded days:** if the median lifetime of
   qualifying gaps is **under 50ms**, stop. That is a hard stop for
   research: only a co-located bot gets those.
2. **Build bar, after 14 recorded days:**
   - unwound capture of at least **$10 a day at +100ms** over the 14
     days; and
   - both weeks positive.

   Held capture is reported beside it, never instead.
   - If +250ms also clears, the trader's current setup could take it.
   - If only +100ms clears, it depends on task 2 (what speed is worth).
3. **Co-location is reported, never recommended,** unless capture at
   +0/+25ms is about **$100 a day or more**, sustained out of sample.
   Even then it is the user's spending decision, not research.

Every recorded day comes after step 1's window, so all of this is scored
out of sample.

## Before reading the archive back

After the first full day, the archive's size is reported, along with
what a 14-day read costs in Storage egress. Analysis runs as a workflow
on the `m15-analysis` queue, one at a time, never 15:45-16:45 UTC.

## Code and tests

- **`lib/ladderBook.js`** (pure, tested): gap episodes from a stream of
  book states, and the fill and legging replay.
- **Tests:** synthetic books only. Recorded data is never committed, so
  no fixture can be copied from the archive. The book encoding stays
  pinned by `lib/kalshiBook.js`'s existing tests, whose fixtures were
  copied from live responses.
- **Mutation-checked**, like step 1.
- **`scripts/ladder-gaps.mjs`** reads the archive and prints lifetimes,
  capture and both verdicts.
- **No order endpoint anywhere:** `scripts/no-order-endpoints.test.mjs`
  stays and must still pass.

## Order of work

1. Scope check on the cached tape. Report.
2. Recorder, unit and tests, merged, with the box steps in
   `deploy/README.md`.
3. You start it on the box. After one hour: load figures and archive
   size. Report.
4. Day 3: the early stop. Report.
5. Day 14: the build bar. Recorded in m15.md with the run id.

## Note, 2026-11-15 (before anything was recorded)

**The scope check passed** (`scripts/ladder-scope.mjs`, m15.md "Ladder
step 2: the scope check"): the scope keeps 82.2% of step 1's 100ms edge
against the 80% bar, so it stands.

**One change in how the reference price is found.** The plan said the
ladder strikes are those within ±2.5% of the 15-minute window's strike.
That strike is not known until the window opens, 15 minutes before the
close, and the recorder has to choose a minute earlier. So the recorder
reads the reference from the ladder itself: the "above X" market whose
two-sided quote has its mid nearest 0.50 is at the money
(`chooseLadderScope` in `lib/ladder.js`). The two differ by a minute of
price movement, far inside the ±2.5% band. The scope check used the
window's strike; nothing about the bars changes.

**Built and merged:** `scripts/ladder-stream.mjs`, its unit
`deploy/marketslap-ladder-stream.service`, the box steps in
`deploy/README.md`, and `scripts/ladder-stream.test.mjs`, which drives
the recorder end to end against the fake Kalshi, including both load
stops. The load stop for `m15-stream`'s own lag is read from that
recorder's journal after the first hour, since one process cannot see
another's lag.

**Still to build, before day 3:** `lib/ladderBook.js` and
`scripts/ladder-gaps.mjs` (gap lifetimes and the fill replay). They read
the archive, so they cannot change what is recorded.

## First close recorded, 2026-11-15 06:00 UTC

The user started the recorder on the box at 05:49:05 UTC, inside the
05:44-06:00 window, so the first record is 11 of 16 minutes (marked
late in its `sel` line). Read from the archive by run 43683996581
(`source: laddersizes`) and from the box's journal:

| | |
|---|---|
| markets | 66 (65 ladder strikes within 2.5% of 64,699.99, plus KXBTC15M), of 376 listed |
| book changes | 906,370: KXBTC15M 431,718, KXBTCD 337,508, KXBTC 137,144 |
| trades | 41,656 |
| gaps, errors, reconnects | none |
| receive lag (the stop is p99 over 1,000ms) | p50 12ms, p99 20ms typical, worst p99 31ms, worst single frame 72ms |
| event loop | 10.5% busy at most |
| memory available on the box (the stop is 100MB) | never under 213MB; 275MB before, 283MB after |
| recorder memory | 91MB |
| `marketslap-m15-stream` | active, no BEHIND line |
| file | 10.7MB for 11 minutes |

**The load stops are nowhere near.** No load reason to stop.

**Size and egress:** about 15.6MB for a full 16 minutes, so roughly
375MB a day and **about 5.2GB over 14 days**. Reading it all back once
for the analysis is 5.2GB of Storage egress; the day-3 read is about
1.1GB.

**Seen once, for the analysis to expect:** the count of full books
doubled at the close with no reconnect, so Kalshi appears to send a
snapshot per market when it closes. Harmless to the record.

## Pipeline test on the first recorded day, 2026-11-16 (not a verdict)

Run 43911171647 (`source: laddergaps`, 11-15 only: 28 files, 276MB
read). It proves `scripts/ladder-gaps.mjs` end to end on real data. The
plan's early stop needs 3 days; nothing below changes any parameter.

- 19 closes, **52 qualifying gaps**, all KXBTC against KXBTCD.
- **Median lifetime 6ms** (p10 1ms, p90 18ms); 98% under 50ms; 49 of 52
  closed by a trade on one of the legs.
- Fill replay, 36 attempts: at +0ms both legs filled 15 times (40
  contracts); at +25ms and later, **never**. One-legged fills unwound
  lose at every delay from +25ms (-$29 at +100ms, 40 contracts).
- No sequence gaps; every settlement found.

One day, so it decides nothing. It points the same way as step 1's
hand checks: the gaps are real, small in number once measured on books
rather than prints, and taken within milliseconds.

The recorder's first full day (run 43889262589): files of 14-18MB an
hour and 32MB in the busiest (14:00 UTC: 2.86M changes); receive lag
p99 typically 21ms, worst minute 186ms; never under 193MB available.
At that rate the 14 days are nearer 6GB than the 5.2GB first estimated.

## Day-3 early stop, 2026-11-18: STOP

Run 44208436894 (`source: laddergaps`, 2026-11-15..2026-11-18: 100
files, 1,126MB read). The rule fixed before recording: median
qualifying gap under 50ms => STOP. No parameter changed.

| day | closes | qualifying gaps | median lifetime | p10 / p90 | under 50ms | closed by a trade |
|---|---|---|---|---|---|---|
| 11-15 (from 05:49 UTC) | 19 | 52 | 6ms | 1 / 18ms | 98% | 49 |
| 11-16 | 24 | 49 | 4ms | 0 / 13ms | 100% | 43 |
| 11-17 | 24 | 43 | 4ms | 0 / 14ms | 100% | 43 |
| **all** | 67 | **144** | **5ms** | 0 / 14ms | **99%** | 135 |

Every gap was KXBTC against KXBTCD (median edge at open 1.8c). Closer
to the hour they die faster: 4ms in the last minute, 9ms at 5-16
minutes out.

The fill replay, 87 attempts, one-legged fills unwound at the bid (the
plan's measure):

| delay | both legs (40 / 10) | unwound a day, 40 | unwound a day, 10 |
|---|---|---|---|
| +0ms | 41 / 71 | +$2.74 | +$5.58 |
| +25ms | 2 / 3 | -$39.07 | -$9.67 |
| +50ms | 0 / 0 | -$26.00 | -$6.24 |
| +100ms | 0 / 0 | -$27.79 | -$7.21 |
| +250ms | 0 / 0 | -$36.60 | -$8.95 |

- From +25ms on, both legs almost never fill; a one-legged position
  unwound loses at every delay. **Even +0ms, which no one outside
  Kalshi's matching engine can reach, makes $2.74-5.58 a day**, under
  the $10 build bar.
- The "held to settlement" column is positive ($13.59 a day at +100ms,
  10 contracts) and is NOT an edge: a leg held to settlement is a
  directional bet on Bitcoin's hourly close, and 3 days of it says
  nothing. The plan measures unwound for that reason.

**Verdict: STOP.** The gaps are real, about 48 a day, and taken by
another bot within single-digit milliseconds, mostly by a trade on one
of the legs. The recorder is no longer needed; turning it off is the
user's step on the box:
`sudo systemctl disable --now marketslap-ladder-stream.service`.
Its archive (`ladder/` in the private bucket) is kept unless the user
decides to delete it.

Recorder health at the stop (run 44212039356, `laddersizes`): 416.7MB
over the last 24 hours, the 23:00 UTC hour read in full: 66 markets,
1.44M changes, receive lag p99 median 27ms (worst 65ms), memory never
under 259MB, no gaps, errors or drops. It worked as built for all three
days; the stop is the market's answer, not the recorder's.
