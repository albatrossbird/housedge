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
