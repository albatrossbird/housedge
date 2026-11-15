# A volatility flag for the live rules: plan, fixed before the test

Written 2026-11-15, before any rule's trades were split by volatility.
Nothing below changes after the first scored number except by a dated
note saying what changed and why.

## Why

On 2026-11-14 both live rules stopped (m15.md "2026-11-14"). By
Kalshi's own 15-minute settlements it was the most volatile Bitcoin day
of the last 61: 15-minute moves of 34.8bp against a median day's 17.2bp,
and Bitcoin down 6.9% over the day. 11-13 was third. The question is
whether volatility predicts when the rules lose, so that a flag could
keep them out of those windows.

**The idea came from one bad day, so it is a candidate, not a finding.**
The 8 live days point both ways: 11-10 was the 9th most volatile day and
sharp-move made $63. Hence this test.

There are reasons it could work:
- **Sharp-move** buys on a 1bp BRTI move. On a volatile day 1bp moves
  are everywhere and may carry less information.
- **p75** buys the favourite at 75-97c. On a volatile day favourites
  flip in the final 30 seconds more often.

## Hypothesis

- **H1:** each rule makes less per contract in windows whose recent
  volatility is high, enough that skipping those windows improves the
  rule.
- **H0:** volatility makes no difference that the data can see.

## The flag, fixed now

- **Volatility series:** each KXBTC15M window's 15-minute log return,
  `ln(expiration_value / floor_strike)`. A window's `floor_strike` is
  the previous window's settlement average, on 11,925 of 11,925 checked
  (m15.md "Ladder consistency"). Public `/markets` (and
  `/historical/markets` before the live tier), no key.
- **Trailing volatility at a decision:** the standard deviation of the
  8 most recent 15-minute returns that had settled before the decision's
  window opened, i.e. the last 2 hours. Every input is known before the
  window starts, so the flag can be run live.
- **Flagged:** trailing volatility at or above the 67th percentile
  (the top third). The cutoff is computed on the train half only and
  then frozen.
- **Action:** skip flagged windows.

Only this one flag is scored. The 24-hour version and the full tercile
table are printed beside it, never as a second chance.

## Data and split

| rule | trades | source | train | test |
|---|---|---|---|---|
| sharp-move | every 1bp decision, 40 contracts, +250ms, limit seen +1c, held to settlement | `m15-index.mjs --list` (recorded BRTI and books), workflow `source: index` | 10-01 .. 10-22 | 10-23 .. 11-14 |
| p75 | every taker buy 75-97c at 15-45s out, 40 contracts, held to settlement | `m15-tape-backtest.mjs` on Kalshi's trade tape | 07-01 .. 09-22 | 09-23 .. 11-14 |

- **Sharp-move** is priced at +250ms because that is the delay the
  `--list` output carries and the one every earlier review used.
- **p75** needs a per-trade list from the tape backtest (`--out=`,
  added for this). The decision rule does not change.

## Pass bar, on the test half only

For each rule separately, the flag passes only if all of these hold:
1. Unflagged minus flagged profit per contract is positive with
   **t >= 2**, counting each trade once (Welch t on per-contract P&L).
2. Skipping flagged windows raises the rule's profit per contract
   against taking every trade.
3. The difference has the same sign in the train half.
4. The test half holds at least **50 flagged trades**.

**Otherwise the flag fails for that rule.** It is recorded in m15.md
with the run ids and not retried with another window (1h, 4h), another
cutoff (top quarter) or another measure. Any of those would be a new
candidate, scored on days after 11-14.

## What it can and cannot decide

- **A pass** is evidence for a rule change: "no new orders while
  trailing 2-hour volatility is in the top third". It goes to the
  trader only as part of a decision to restart a rule, which is the
  user's call. Both rules stay stopped either way. A pass does not make
  either rule profitable; it only shows the flag helps.
- **A fail** means 11-14 was a bad day in a volatile market, not a
  pattern a flag can catch.

## Cost and order of work

1. `lib/volFlag.js` (pure: returns, trailing volatility, percentile,
   flag) with a test, mutation-checked; `--out=` on the tape backtest;
   `scripts/vol-flag.mjs` to join trades to the flag and print the
   verdict. Committed before any trade is scored.
2. The volatility series: about 130 days of KXBTC15M settlements,
   roughly 15 requests to Kalshi, run from this session.
3. p75's trades: the 4-month tape read, from this session (public, no
   key; about 25 minutes at Kalshi's rate limit).
4. Sharp-move's decisions: one workflow run (`source: index`,
   10-01..11-15, `--list`), on the `m15-analysis` queue, never
   15:45-16:45 UTC. It reads 45 days of recorded BRTI from Storage, as
   earlier index runs have.
5. Score, record in m15.md with the run ids, report.
