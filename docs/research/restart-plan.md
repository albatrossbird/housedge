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

## Sharp-move: tweaks checked, 2026-11-16

Asked whether anything could improve its performance or risk. Same 30
days (10-16..11-14, run 43676630129, 684 1bp decisions, 522 filled at
+250ms; 40 contracts unless said). Every row is a cut read off this
data, so a "better" row is a candidate at most.

**Settings: the current ones are at or near the best row.**

| lever | result | verdict |
|---|---|---|
| move threshold | 1bp +3.33c (t 2.02) at +100ms; 2bp +1.06c (t 0.44); 4bp +9.11c on 53 decisions with halves +29c / -4c | keep 1bp |
| limit, at +100ms (live runs ~82ms) | seen +3.21c, **+1c +3.33c**, +2c +2.66c, +3c +2.71c | keep +1c |
| limit, at +250ms | +2c fills 83% against 76% and its added contracts made +7.81c (t 1.46) | only matters if fills get slow |
| mid band | 0.15-0.85 +2.79c; 0.20-0.80 +2.10c; 0.25-0.75 +0.93c; 0.30-0.70 -0.66c | narrowing hurts |
| seconds to the close | 90-118s +1.95c (392 fills), 60-90s +4.99c (109), halves disagree | nothing |
| move size | 1-1.25bp +2.23c, 1.25-1.5bp +5.33c, 1.5-2bp -0.48c, 2bp+ +5.22c | no pattern |
| side bought | YES +5.28c (both halves positive), NO +0.39c; t 1.36 | watch, do not act |
| take profit 5/10/15c | costs 3.4-4.8c a contract, t -3.1 to -3.9 | never |
| stop loss 10c | -0.74c a contract (t -0.56) | no |
| sell or add at 15s out | each costs about 5c a contract traded | no |

**Missed orders are the better ones.** The 162 orders that did not fill
went on to win 52.5% at an average 0.455; the 522 that filled won 48.7%
at 0.456. Fills are the trades nobody else wanted quite as much. Neither
speed (m15.md "What speed is worth") nor a wider limit at 82ms gets them
back profitably.

**Risk, at 10 contracts** (backtest mean +$4.83 a day, sd $17.2, worst
day -$30, deepest drawdown $31):

| rule | mean a day | sd | worst day | largest single loss |
|---|---|---|---|---|
| 10 contracts, as it is | +$4.83 | $17.2 | -$30 | -$8.70 |
| 5 contracts | +$2.42 | $8.6 | -$15 | -$4.35 |
| stop for the day at -$30 | +$4.76 | $17.4 | -$32 | |
| stop for the day at -$20 | +$4.28 | $17.8 | -$25 | |
| stop for the day at -$15 | +$3.26 | $18.1 | -$19 | |
| at most 8 trades a day | +$2.66 | $11.2 | -$18 | |
| stop after 4 losses in a row | +$2.50 | $15.4 | -$19 | |
| equal dollars a trade ($4.50 / price) | +$3.62 | $21.3 | -$30 | -$5.06 |

- **Size is the only lever that cuts risk without cutting the edge per
  dollar at risk.** Halving the size halves everything.
- Daily stops and trade caps trim the worst day a little and give up
  more in average than they save; the trades are close to independent,
  so stopping after losses skips trades that are as good as any other.
- Equal dollars a trade is worse: it puts the most contracts on the
  cheapest underdogs, where the edge per contract is thinnest.

**The two rules in one window.** Since 10-16, 276 of p75's 460 tape
trades fell in a window where sharp-move also held a position: the
same side in 121 (both lost in 13), opposite sides in 155. Opposite
sides offset. The same side doubles the stake on one outcome. If both
restart, the cost of "p75 skips a window where sharp-move already holds
that side" is the next thing to measure.

## Both rules in one window: the question, fixed before the numbers

Written 2026-11-16 after only the counts above had been seen (276
shared windows: 121 same side, 155 opposite; both lost in 13).

**The question:** if both rules restart, should p75 skip a window in
which sharp-move already holds a position?

**Data:** p75's tape trades and sharp-move's recorded-book decisions
(the 1bp decisions that filled at +250ms, seen +1c), joined on the
window's ticker, over every day both exist. Sharp-move's list is being
extended back to 10-01 (the index script now reads an older span on its
own). Both at 10 contracts.

**Three candidate rules,** beside doing nothing:
- A: p75 skips a window where sharp-move holds the SAME side.
- B: p75 skips any window where sharp-move holds a position.
- C: p75 skips a window where sharp-move holds the OPPOSITE side.

**How it is decided.** This is a risk rule, so it is judged on risk and
on what it gives up, not on a t value for an edge:
- Adopt A if p75's same-side trades do not make clearly more per
  contract than its other trades (a gap under t 2 in their favour), and
  A lowers the largest loss in a single window and the worst day. It
  then costs nothing measurable and removes the doubled stake.
- Keep both rules independent if the same-side trades are clearly
  better (t >= 2): then the doubled stake is where p75's edge is.
- B and C are reported for completeness. C is not expected to help:
  buying the favourite while holding the underdog offsets the position.

### First read, 10-16..11-14 (30 days), and a hypothesis fixed for new days

`scripts/rule-overlap.mjs`, 10 contracts each, 459 p75 tape trades and
522 filled sharp-move decisions:

| sharp-move already held | p75 trades | won | per contract | halves | vs nothing held |
|---|---|---|---|---|---|
| nothing | 183 | 91.3% | +3.14c | +5.31c / +0.74c | |
| the same side | 121 | 89.3% | +0.96c | +4.10c / -2.35c | -2.18c, t -0.63 |
| the other side | 155 | 84.5% | **-2.86c** | -3.10c / -2.66c | **-5.99c, t -1.70** |

**Not what the plan above expected.** The doubled stake (same side) is
not where p75 loses. It loses when it buys the favourite AGAINST a
sharp move from the last two minutes: the favourite then won 84.5% at
0.866 paid, under what its price needs. A move toward the strike late
in the window is a reason the favourite is less safe than it looks.

That was read off these 30 days, so it is a candidate. **Fixed now,
before 10-01..10-15 is read** (sharp-move's decisions for those days do
not exist yet; the run is about to be made):
- **Hypothesis:** p75's trades in a window where sharp-move holds the
  other side make less per contract than p75's other trades.
- **Confirmed** if the gap is negative on 10-01..10-15 alone AND reaches
  t <= -2 over all 45 days. Otherwise it stays a candidate.
- Secondary, reported only: the same split using every sharp-move
  decision, filled or not (the signal rather than the position).

### Result, 2026-11-16: the hypothesis FAILS, and it was mostly lookahead

Sharp-move's decisions for 10-01..10-15 were made by run 43911164998
(324 decisions, 254 filled), giving 45 days in all: 717 p75 tape trades,
1,008 sharp-move decisions, 776 filled.

**A correction first.** The first read above counted ANY sharp-move
decision in the window, including ones made after p75 had already
bought. A late move against the favourite is, of course, followed by
the favourite losing; that is not something p75 could have acted on.
`scripts/rule-overlap.mjs` now counts only what sharp-move had done
before p75's entry. The -2.86c above was largely that lookahead.

**The fixed hypothesis, done properly:**

| | p75 trades with sharp-move on the other side | vs every other p75 trade | t |
|---|---|---|---|
| 10-01..10-15 (unseen) | 64, +0.71c | -4.03c | -0.93 |
| all 45 days | 214, -0.74c | -3.46c | -1.32 |

Negative on the unseen days, but t -1.32 over 45 days against the -2
it needed. **Not confirmed.** By the signal (any earlier decision
against p75's side) it is weaker still: -1.76c, t -0.73. No "against
sharp-move" rule goes to the trader.

**What the 45 days do show** (10 contracts each):

| when p75 traded, sharp-move already held | p75 trades | won | per contract | halves |
|---|---|---|---|---|
| nothing | 297 | 90.6% | +2.17c | +2.83c / +1.44c |
| the same side | 206 | 91.3% | +3.52c | +7.52c / -1.44c |
| the other side | 214 | 86.9% | -0.74c | +0.51c / -1.83c |

- **The two rules are independent day to day:** the correlation of
  their daily P&L is -0.02. Running both spreads risk; it does not
  stack it.
- **Inside one window they can stack.** In the 206 same-side windows
  both won 188 times and both lost 18 times, at an average of -$13.36
  for the pair and a worst of -$17.78.

**The risk rules, both rules together:**

| rule for p75 | p75 trades | both, $ a day | sd | worst day | worst window | windows losing $10+ |
|---|---|---|---|---|---|---|
| none | 717 | $10.98 | $20.7 | -$48 | -$17.78 | 16 |
| A: skip sharp-move's same side | 511 | $9.37 | $17.1 | -$31 | -$9.72 | 0 |
| B: skip any sharp-move window | 297 | $9.72 | $19.2 | -$37 | -$9.72 | 0 |
| with p75's two time filters, no rule | 366 | $11.95 | $19.1 | -$30 | -$15.17 | 7 |
| with the two time filters, and A | 244 | $10.30 | $17.8 | -$30 | -$9.72 | 0 |

The dollar-a-day figures are flattered: 10-01..10-15 is inside the
period sharp-move was found on (it made +9c a contract there against
+2.8c on the 30 days after).

**Superseded by the correction below (do not adopt A).** As first written: **Decision, by the rule fixed above: adopt A.** p75's same-side trades
do not make clearly more than its other trades (+1.34c, t 0.52), and A
takes the largest single-window loss from about $18 to about $10 and
the worst day from -$48 to -$31. With p75's time filters already on,
the worst day is the same either way and A only caps the window. It
costs about $1.60 a day of backtest average, which is the price of the
cap. Review it at the 300-settled review with the live fills.

### Correction, 2026-11-16: do NOT adopt A

The user asked the right question: the table shows p75 doing WORST with
sharp-move on the other side (-0.74c) and BEST with it on the same side
(+3.52c), yet rule A skips the same side.

A was a risk rule (cap the loss in one window), not a performance rule,
and adopting it was a mistake in how the decision rule was written. "Not
clearly better at t 2" was read as "no better", when the point estimate
says the same-side trades are p75's best. With the two time filters on:

| p75's trades (time filters on, 45 days) | trades | per contract | $ a day at 10 |
|---|---|---|---|
| all | 366 | +4.50c | $3.66 |
| sharp-move on the same side (what A removes) | 122 | about +6.1c | $1.65 |
| sharp-move on the other side | 137 | about +2.4c | $0.72 |
| nothing held | 107 | +5.45c | $1.29 |

- **A gives up 45% of p75's backtest profit** ($3.66 to $2.01 a day) to
  take the worst single window from -$15 to -$10. The worst day is -$30
  either way. That is a bad trade.
- **Skipping the other side is not supported either.** It failed its
  fixed test (t -1.32), and with the time filters on those trades made
  about +2.4c: the losses on that side sit in the evening and weekend
  windows the time filters already remove.

**Revised: no cross-rule at restart.** p75 runs with its two time
filters only. The doubled stake in one window is accepted at 10
contracts: a worst window of about -$15 to -$18 sits inside one day's
normal swing (about $19). Looked at again, with live fills, at the
300-settled review.

### The reverse rule, and the bar for a skip (2026-11-16)

**Sharp-move skipping a window where p75 already holds: almost never
applies.** Sharp-move decides 118s to 6s before the close and p75 at
45s to 15s, so sharp-move is nearly always first. In 45 days, 24 of
1,008 sharp-move decisions came after p75 had bought (9 filled), all
14-45s out:

| sharp-move, after p75 held | filled | won | sharp-move made | p75 made in those windows |
|---|---|---|---|---|
| the same side | 1 | 1 | +$3.34 | +$0.28 |
| the other side | 8 | 5 | +$21.17 | -$42.43 |

Skipping them would give up nine trades that made $24.51 (10
contracts). No rule. What the row does show: when a sharp move goes
against a favourite p75 already holds, p75 loses badly ($42 in 8
windows). p75 cannot avoid that by skipping, since it has already
bought, and selling out was tested and loses (m15.md, exits).

**The user's bar for a SKIP: act at |t| >= 1, not 2.** Reasonable for a
rule that only removes trades from a thin-edged strategy: a wrong skip
gives up a little, a right one avoids losers. Two guards keep it from
skipping on noise. About one cut in six clears t -1 by luck, and some
forty cuts have been printed for these two rules.

A skip is adopted when all three hold:
1. the skipped trades are worse than the rest at **t <= -1**;
2. the skipped trades **lose money** themselves (negative per contract),
   not merely earn less;
3. they are worse than the rest in **both halves** of the days.

Every skipped window keeps being scored on the tape, and a skip is
dropped if its windows turn out better than the traded ones. Adding
size or trades on a t above +1 is NOT covered: that adds risk on thin
evidence, and stays at t 2.

**What passes today:**

| cut | t vs rest | skipped trades made | both halves | verdict |
|---|---|---|---|---|
| p75, 16:00-20:00 New York | -1.95 | -1.42c | yes | skip (already proposed) |
| p75, weekends | -1.54 | -0.27c | yes | skip (already proposed) |
| p75, sharp-move on the other side, no time filters | -1.32 | -0.74c | yes | would pass |
| p75, sharp-move on the other side, WITH the time filters | -0.69 | **+2.36c** (+2.12c / +2.59c) | | no: they make money |
| sharp-move, 00:00-04:00 New York | -1.35 | -3.13c | no (-11.13c / +4.66c) | no |
| sharp-move, buying NO | -1.36 | +0.39c | no | no: not losing |

So the proposal is unchanged. The other-side trades lose only inside
the evening and weekend windows the time filters already remove (77
trades at -6.25c there); outside them they made +2.36c.

### Sharp-move, midnight to 4am New York time, on all 45 days (2026-11-16)

The user asked to skip this block "since it lost money overall". That
was true of the 30 days in the table above (-3.13c). On the 45 days now
in hand it made money:

| period | 00-04h trades | per contract | at 10 contracts | the rest | t vs rest |
|---|---|---|---|---|---|
| 10-01..10-15 | 34 | +10.91c | +$37.11 | +8.70c | 0.31 |
| 10-16..10-30 | 37 | -11.13c | -$40.14 | +5.22c | -2.18 |
| 10-31..11-14 | 37 | +4.66c | +$17.26 | +2.48c | 0.30 |
| all 45 days | 108 | +1.33c | +$14.23 | +5.40c | -1.02 |

One bad fortnight out of three. Against the skip bar: t -1.02 passes
the first test by a hair, but the skipped trades made money and two of
three periods were better than the rest, so it fails the other two.
Skipping it would have cost about $0.32 a day over the 45 days.

Not in the trader message by default. A one-paragraph rule change is
kept beside it for the user to send if they still want the skip; it is
their call.
