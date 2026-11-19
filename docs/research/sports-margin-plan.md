# Buy the leader late, by lead and price: plan, fixed before any data is read

Written 2026-11-18, at the user's suggestion, after the late-favourite
test failed (`sports-late-plan.md`: 3:00 left, 75-97c, -1.32c a
contract, t -2.31). The idea: buy the team that is ahead with **T** left,
only when it leads by at least **M**, and only when Kalshi prices it
under **P**. A big lead priced cheaply is where the market would be
slow, if it is slow anywhere.

## Why this needs a different design

Three numbers chosen by looking at results will always find something
that worked in the past. 27 combinations per league, five leagues, is
135 tries; at t >= 2 about three would pass by luck alone. So the
numbers are **chosen on one period and tested once on another** that
the choice never saw.

- **Choose on window A** (2025-10-01..2026-02-28).
- **Test on R + B** (2026-03-01..2026-05-31 and 2026-09-01..2026-11-17).
  R was reference only in the late test; its one printed row (3:00
  left, 75-97c, any lead: +1.33c on 467 trades) is the only thing seen
  from it, and no lead was used there.

No trade at any lead has been read. The late test's per-league rows at
3:00 left (any lead) are known.

## The grid (fixed now)

- **Time left in the final period** (game clock, as the late test):
  6:00, 3:00, 1:00. Decision = that play's wall-clock + 10 seconds;
  entry = the first taker print in the next 15 seconds.
- **Lead**, the leader's lead on the score at the decision play:
  - NBA, men's college basketball: at least 6, 10, 15 points.
  - NFL, college football: at least 4, 9, 17 points (more than a field
    goal, more than one score, more than two scores).
  - NHL: at least 1, 2, 3 goals.
  - Tied: no trade.
- **Price**: the print must BUY THE LEADER (YES on its market, or NO on
  the other team's) at 50c up to a cap of 80c, 88c or 95c.
- 10 contracts, taker fee (multiplier 1), held to settlement. One trade
  per game per cell.

That is 27 cells per league.

## Choosing (window A only)

Per league, the cell with the highest t by day among cells with at
least 60 trades in A and a positive mean. If that best cell's t is
under 1, the league is dropped and not tested. Ties go to more trades.

## The test (R + B, once)

Each chosen league rule (at most five) passes only if, on R + B:
1. mean profit per contract after fees positive at **t >= 2.3** by day
   (the 2.0 bar raised for up to five tests at once);
2. positive in R and in B separately (NFL and college football have no
   R games: B alone);
3. at least 60 trades.

## Stop rule

A league rule that passes goes to a 4-week paper record on live games
(decisions logged, no orders), and only then to the trader at 10
contracts. If none passes, "buy the leader late" stops: no new leads,
times or caps on this data.

## Plumbing (no trade or result read)

- the leader is known at the decision play (score present) in at least
  95% of decided games per league;
- the leader maps to exactly one of the game's two Kalshi markets in at
  least 99% of those.

## What a pass would not show

- Size: a print is one trade, not ten contracts' worth.
- Feed speed live (+10 seconds is a guess; the late test found +5s and
  +30s change little).
- The risk shape: buying at 88c risks $8.80 to make $1.20 at 10
  contracts. A lead filter can raise the win rate; it does not change
  that one loss costs about seven wins.

## Result, 2026-11-18: FAIL. "Buy the leader late" stops.

`node scripts/sports-half.mjs --margin`, from the late test's cache (no
new Kalshi reads). Plumbing clears: score known at 100% of decisions in
every league, and the leader maps to one market in 100% of those with a
leader (tied decisions, not traded: NBA 130, NHL 1,179, NFL 78, college
football 285, men's college basketball 504).

**Choosing on A.** Four leagues have no cell with 60+ trades, a positive
mean and t >= 1, and are dropped untested:

- NBA: best 60+ cell is 3:00, lead >= 6, 50-95c at +2.01c, t 0.84
  (125 trades).
- NHL: best is 6:00, lead >= 1, 50-95c at +1.19c, t 0.70 (319).
- NFL: 6:00, lead >= 4, 50-95c at +1.46c, t 0.29 (68); the cells that
  look strong have 2-43 trades.
- College football: no positive 60+ cell (3:00, lead >= 4, 50-95c is
  +0.01c on 92).

Men's college basketball chose **1:00 left, lead >= 6, 50-95c**: 69
trades on A, all 69 won, paid 93.1c, +6.47c a contract.

**The test on R + B, once:**

| | trades | won | paid | per contract | t |
|---|---|---|---|---|---|
| **R + B** | **16** | 100% | 93.2c | +6.37c | 8.63 |
| R | 10 | 100% | 92.5c | +7.02c | 6.54 |
| B | 6 | 100% | 94.3c | +5.29c | 5.66 |

**FAIL: 16 trades against the 60 the bar needs.** Every trade won, so
the t is not meaningful: with no losses its spread comes only from the
price paid. What the 16 can say is little. A side fairly priced at 93c
loses about 7% of the time, and 16 straight wins happen about one time
in three at that rate (0.932^16 = 0.32). The 69 on A were the best of
27 cells, so they are not evidence either.

Per the stop rule, "buy the leader late" stops: no new leads, times or
caps on this data.

**One candidate, recorded and nothing more.** The exact chosen rule
(men's college basketball, 1:00 left, lead >= 6, buy the leader at
50-95c, +10s, 15s look) may be re-scored, unchanged, with this same
code on games played after 2026-11-17, once there are at least 60
trades (about one college basketball season). Bar fixed now: mean
positive after fees AND **at most 1 loss in the first 60 trades**. If
it were fairly priced at ~93c, at most 1 loss in 60 would happen about
7% of the time. Break-even at 93c is roughly 4 losses in 60, so one
loss costs about 14 wins. A print is one trade, so size is unknown.

## The forward record, fixed 2026-11-19 before any forward result was read

Run weekly with `node scripts/sports-half.mjs --forward=<today>
--leagues=ncaamb`: the one candidate rule above, unchanged, on games
from 2026-11-18. The bar, checked in time order as trades arrive:

- **FAIL at the second loss**, whenever it comes. At 93c a contract the
  rule cannot pass with two losses, so the test stops there and does not
  wait for 60 trades.
- **PASS at 45 straight wins**, or at **at most 1 loss in 60**, in both
  cases only if the mean after fees is positive. 45 straight wins is the
  earlier exit the user asked for. If the true price were fair (~7%
  losses), passing either way would happen about 8% of the time, against
  7% for the 60-trade bar alone.
- Otherwise it is still running. In window A the rule fired about once
  every two days, so 45 trades is about early February and 60 about
  March. Only a loss can end it sooner.

A pass leads to a live paper log that records what was actually on offer
at decision time, and only then to the trader. A print is one trade, so
size is still unknown.
