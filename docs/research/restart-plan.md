# Bringing p75 and sharp-move back at small size

Written 2026-11-16, at the user's request, after both rules stopped on
2026-11-14 (m15.md "2026-11-14"). The user decides whether to restart;
this is the evidence and a proposal. Nothing here is a profit promise:
every backtest figure is an upper bound, and the filters below were read
off the same data they are scored on.

## The short version

- **Sharp-move:** no time of day or day of week is worth avoiding. What
  hurt on 11-14 was size. Restart at **10 contracts, no time filter**.
- **p75:** two filters lean the same way in both halves of 4.5 months:
  **skip 16:00-20:00 New York time, and skip Saturday and Sunday.**
  Neither is proven. Restart at **10 contracts with both filters**, and
  keep scoring the skipped windows on the free trade tape, so the
  filters are tested on new days while the bot runs.
- **Money at risk:** a $100 drawdown stop on sharp-move and $75 on p75,
  $175 in all. Expect a few dollars a day at best, and possibly zero.

## p75: where it lost

Kalshi's public trade tape, 2026-07-01 to 11-14, 2,251 trades, 40
contracts, held to settlement (`scripts/m15-tape-backtest.mjs`). The
halves split at 09-23. "vs rest" is the gap to every other trade, with a
per-trade Welch t.

| when (New York time) | trades | per contract | first half | second half | vs rest | t |
|---|---|---|---|---|---|---|
| all | 2,251 | +1.25c | +0.96c | +1.73c | | |
| 00-04h | 380 | +0.23c | -2.04c | +4.44c | -1.23c | -0.70 |
| 04-08h | 371 | +3.33c | +5.32c | +0.62c | +2.49c | 1.50 |
| 08-12h | 334 | +0.78c | +2.12c | -1.48c | -0.55c | -0.30 |
| 12-16h | 352 | +2.25c | +1.20c | +3.88c | +1.18c | 0.68 |
| **16-20h** | 451 | **-1.42c** | -1.97c | -0.48c | **-3.34c** | **-1.95** |
| 20-24h | 363 | +2.98c | +2.48c | +3.84c | +2.06c | 1.28 |
| **weekend** | 692 | **-0.27c** | -0.66c | +0.32c | **-2.20c** | **-1.54** |
| weekday | 1,559 | +1.93c | +1.66c | +2.39c | | |

By day: Saturday -0.59c (worse than the rest in both halves), Sunday
+0.14c (mixed). Monday, Thursday and Friday were better in both halves.

**Only two cuts were worse than the rest in both halves: 16-20h and the
weekend.** Both were named before today:
- 16-20h came from the trader's live fills and was tested on 11-10 with
  the hypothesis fixed first. It leaned the right way and failed
  (t -0.93 on the days before live).
- The weekend was noted on 11-10 as a candidate.

Neither reaches t 2. They are the two best-supported guesses, not
findings.

**What each filter would have done, at 10 contracts** (same tape; t by
day):

| rule | trades a day | per contract | t | halves | since 10-19 | November | $ a day | worst day | deepest drawdown |
|---|---|---|---|---|---|---|---|---|---|
| p75 as it was | 16.4 | +1.25c | 2.21 | +0.96c / +1.73c | +0.67c | -1.32c | +$2.06 | -$26 | $78 |
| skip 16-20h | 13.1 | +1.92c | 3.05 | +1.71c / +2.27c | +1.94c | -0.28c | +$2.52 | -$28 | $57 |
| skip weekends | 11.4 | +1.93c | 2.89 | +1.66c / +2.39c | +1.19c | -1.15c | +$2.20 | -$20 | $64 |
| **skip both** | 8.9 | **+2.61c** | 3.50 | +1.97c / +3.70c | +3.68c | +1.92c | +$2.32 | -$22 | $48 |
| the skipped windows | 7.5 | -0.35c | -0.38 | -0.29c / -0.45c | -2.78c | -5.03c | -$0.27 | | |

**Read the t values with suspicion.** The filters were chosen on this
data, so 3.50 overstates the evidence. The case for the filters is
that the skipped windows made about nothing over 1,029 trades, in both
halves, so skipping them gives up little even if the filters are wrong.
The case is not that the filtered rule is proven.

**Also seen, not proposed:** p75's 75-85c band made +3.44c (862 trades,
both halves positive) while 85-97c made about zero. Stacked with both
filters it shows +6.32c on 469 trades, which is the most overfitted
number here. The band's planned November re-test is spoiled for
11-01..11-14: this write-up printed it (+0.81c on 78 trades,
inconclusive). Its fair test is now days after 11-14.

## Sharp-move: no time filter

Recorded BRTI and books, 2026-10-16 to 11-14, the 522 1bp decisions that
filled (+250ms, limit seen +1c, 40 contracts; run 43676630129). Halves
split at 10-31.

| when (New York time) | trades | per contract | first half | second half | t vs rest |
|---|---|---|---|---|---|
| all | 522 | +2.79c | +2.81c | +2.78c | |
| 00-04h | 74 | -3.13c | -11.13c | +4.66c | -1.35 |
| 04-08h | 86 | +1.58c | +4.47c | -0.94c | -0.22 |
| 08-12h | 97 | -0.05c | +2.71c | -2.30c | -0.71 |
| 12-16h | 88 | +8.94c | +3.70c | +12.19c | 1.33 |
| 16-20h | 87 | +2.65c | +1.86c | +3.74c | 0.03 |
| 20-24h | 90 | +5.99c | +13.75c | -0.84c | 0.83 |
| weekend | 112 | +3.21c | +8.22c | -1.89c | -0.02 |

Every block swings by 5-15c between the halves. With about 85 trades a
block and ~45c of noise a trade, 30 days cannot tell a bad hour from a
lucky one. The earlier 3.5-month stand-in test had 16-20h and 04-08h as
the best blocks (m15.md "Time of day"); here they are average. **There
is nothing to filter on.**

What the evidence does say about sharp-move:
- Out of sample (10-22..11-15, 546 decisions) it made +3.73c a contract
  at +100ms, t 2.01, both halves positive, 11-14 included (m15.md "What
  speed is worth"). One cell of many printed, so a candidate.
- Live to the 150-fill review it made +3.27c (t 0.82), in line.
- **The 11-14 problem was size.** At 40 contracts one day swings about
  $96 against a $100 stop. At 10 contracts the same days swing about
  $17, with a worst day of -$30.

## The proposal

| | sharp-move | p75 |
|---|---|---|
| size | 10 contracts | 10 contracts |
| time filter | none | no order when the decision time in New York is 16:00-19:59, or on Saturday or Sunday |
| everything else | unchanged | unchanged |
| stop | $100 drawdown from the restart's peak | $75 drawdown from the restart's peak |
| review | at 300 settled: stop if t <= -1 | at 300 settled: stop if t <= -1 |
| backtest at this size (upper bound) | ~17 trades and +$4.83 a day, +-$17 | ~9 trades and +$2.32 a day, +-$8 |

- **No size increase** without a review that passes, and never above 10
  on p75 while its filters are untested.
- The step back to a smaller size on slow fills and the fee check stay
  as they are.

**Testing the p75 filters while it runs (free).** The trade tape scores
every p75 window whether or not the bot traded it. From the restart day,
the skipped windows (16-20h and weekends) are scored beside the traded
ones. Fixed now: after 8 weeks, a filter is dropped if its skipped
windows made MORE per contract than the traded ones; it is kept
otherwise, and called confirmed only at t >= 2.

**Before restarting p75, one check from the trader:** split the 302
live p75 fills the same way (16-20h or weekend, against the rest). If
the live skipped fills did better than the rest, do not restart p75 on
this proposal.
