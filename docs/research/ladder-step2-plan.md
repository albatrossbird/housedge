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
