# Late favourites in sports games: plan, fixed before any data is read

Written 2026-11-18, at the user's request, from `strategy-survey.md`
test 1. Nothing has been read yet but feasibility checks that look at no
trade and no result: ESPN's play-by-play carries wall-clock times on
every play for the five leagues below, and Kalshi's historical tier
serves trades from before its cutoff.

## Hypothesis

p75's idea carries over to sports: late in a game, the side Kalshi
prices at 75-97c wins more often than its price says, by more than the
taker fee. Two papers point this way: on Kalshi as a whole, contracts
above 70c earn small positive returns after fees (Bürgi, Deng and
Whelan); in Kalshi's NBA, MLB and NHL markets, calibration turns
step-like in the final 10 minutes, favourites winning more than priced
(Moshrefi, arXiv 2607.14430).

**The trap the papers leave.** Both measure "late" by the market's
actual close, which comes when the winner is declared. A trader cannot
see that coming. Overtime, a comeback and a blowout all close at
different times, and conditioning on the real close smuggles in the
answer. So here "late" is the **game clock**, read from ESPN's public
play-by-play, as a trader watching the game would read it.

## The rule (one primary cell)

- **Leagues:** NBA, NHL, NFL, college football (FBS games Kalshi lists),
  men's college basketball. Kalshi series KXNBAGAME, KXNHLGAME,
  KXNFLGAME, KXNCAAFGAME, KXNCAAMBGAME. MLB has no clock and is left
  for a separate test.
- **When:** the first ESPN play in the final regulation period (4th
  quarter; NHL 3rd period; college basketball 2nd half) whose clock
  shows **3:00 or less remaining**. ESPN's NHL clock counts time
  elapsed, so 17:00 elapsed is 3:00 remaining. Decision time = that
  play's wall-clock time **+ 10 seconds** (a public feed is not
  instant).
- **What:** the first taker print in the 15 seconds after the decision
  time, on either of the game's two Kalshi markets, that buys the side
  priced **75-97c** (YES on the favourite's market, or NO on the
  underdog's). That print's price is our price. No print in band within
  15 seconds: no trade, counted.
- **Size and cost:** 10 contracts, Kalshi's taker fee from the series'
  `fee_multiplier`, rounded up to $0.0001 per order (the trader's direct
  account). Held to settlement. One trade per game.

## Data

- **Window A:** 2025-10-01 to 2026-02-28. **Window B:** 2026-09-01 to
  2026-11-17. Together they cover two autumns and one winter.
- **Left out on purpose:** 2026-03-01 to 2026-05-31, the period the
  sports paper's finding came from. It is printed for reference, as a
  check that this code reproduces the paper's direction, and never
  scored.
- Kalshi: settled game markets (result, close time), and trades only
  in each game's 15-second decision windows (tiny reads). ESPN: one
  scoreboard per league per day and one summary per game. Everything
  is cached under `.sports-cache/` (gitignored) and never committed;
  downloaded data stays private.
- **Join:** Kalshi game to ESPN game by the game's Eastern date (plus
  or minus a day) and both team names, normalised. Codes are not used:
  CLAUDE.md records how often the venues' codes disagree.

**Plumbing checks before anything is scored**, none of which reads an
outcome or a P&L:
- join rate at least 90% per league, or the join is fixed first
  (aliases only);
- wall-clock present on at least 95% of final-period plays;
- ESPN's last play against Kalshi's close time: the lag is printed,
  and should be a positive minute or two;
- the count of games per league per window.

## The bar (PASS needs all three, on the primary cell, A and B pooled)

1. Mean profit per contract after fees is positive, at **t >= 2** by
   day.
2. Positive in **both windows** (A and B separately).
3. At least **200 trades**.

Also printed, as reference only and never a second chance: each league
alone; decision points at 6:00 and 1:00 left; bands 75-85c and
85-97c; feed delays of +5s and +30s; win rate against average price
paid; dollars a day, worst day and the largest losing streak at 10
contracts; and the paper's own measure (10 minutes before the actual
close), to show what conditioning on the close is worth. **A league or
cell that passes on its own while the pooled rule fails is a candidate,
tested fresh on games after 2026-11-17 before anything else.**

## Stop rule

If the pooled rule fails, the sports late-favourite idea stops here,
whatever a sub-cell shows. If it passes, the next step is a written
plan for a paper record on live games (decisions logged, no orders)
for 4 weeks, then the trader, at 10 contracts like p75.

## What a pass would not show

- That ESPN's feed is fast enough live. The +10s delay is a guess; the
  +5s and +30s rows show how much it matters. Faster official feeds
  exist and other traders use them.
- That the price was there for 10 contracts at once: a print says
  someone traded at that price, not how much more was there.
- That Kalshi's sports fees stay as they are: they changed in 2026.

## Plumbing pass, 2026-11-18 (no trade or result read): clears

| league | games (A / R / B) | joined | wall-clock on final-period plays | decided at 3:00 left |
|---|---|---|---|---|
| NBA | 1,632 (938 / 417 / 277) | 100.0% | 100.0% | 1,627 |
| NHL | 1,816 (973 / 441 / 402) | 100.0% | 100.0% | 1,815 |
| NFL | 369 (220 / 0 / 149) | 100.0% | 99.9% | 369 |
| college football | 1,879 (572 / 0 / 1,307) | 98.9% | 99.6% | 1,851 |
| men's college basketball | 6,008 (4,679 / 592 / 737) | 97.4% | 100.0% | 5,834 |

The unjoined games are small-school opponents ESPN's top-division
scoreboard does not list (Albany, Division III guests). Join fixes
before this pass, from trial games only: accents folded ("San José
State"), ESPN's "LA" read as Los Angeles, and an equal team code
accepted where the names differ ("Appalachian St." / "App State").

**Found here, and it matters for the paper, not for this test.** Until
mid-2026 Kalshi closed NBA, NHL and college basketball markets long
after the game ended: the median gap from ESPN's last play to Kalshi's
close was 15 / 32 / 30 minutes in window A and 12 / 27 / 30 in R,
against 1.5 / 1.3 / 0.9 in window B. The sports paper's data is March
to May 2026 (window R), so its "final ten minutes before close" was,
for those leagues, mostly AFTER the final whistle, when the outcome is
known. Its late-game step-like calibration may partly be that. This
test decides on the game clock and is not affected; the reference row
"10 minutes before the actual close" is, and is read with that in mind
(meaningful in B; mostly post-game in A and R for NBA, NHL and college
basketball).

Scoring follows, unchanged.

## Result, 2026-11-18: FAIL. The idea stops.

Primary cell, scored as fixed above (`node scripts/sports-late.mjs
--score --primary-only`; 22,966 public Kalshi requests, 87 minutes):

| | trades | won | avg paid | per contract | t | days | at 10 contracts |
|---|---|---|---|---|---|---|---|
| **A + B (scored)** | 2,731 | 87.8% | 88.5c | **-1.32c** | **-2.31** | 214 | -$1.68 a day |
| A 2025-10..2026-02 | 2,060 | 87.8% | 88.6c | -1.50c | -2.33 | 147 | -$2.11 a day |
| B 2026-09..2026-11 | 671 | 88.1% | 88.1c | -0.74c | -0.61 | 67 | -$0.74 a day |

7,329 games reached 3:00 left in A + B with no in-band print within 15
seconds and were not traded. All three tests fail: the mean is negative
at t -2.31, negative in both windows, on 2,731 trades. The favourite
won about as often as its price said (87.8% against 88.5c paid), and
the taker fee is the loss. Upper bound as always: a print says someone
traded there, not that ten more were.

Reference rows (never a second chance):

| cell | trades | won | paid | per contract | t |
|---|---|---|---|---|---|
| NBA | 383 | 90.3% | 86.9c | +2.68c | 1.71 |
| NHL | 448 | 89.1% | 91.3c | -2.74c | -2.04 |
| NFL | 102 | 86.3% | 87.0c | -1.52c | -0.50 |
| college football | 426 | 85.7% | 87.8c | -2.81c | -1.81 |
| men's college basketball | 1,372 | 87.5% | 88.3c | -1.49c | -1.88 |
| feed delay +5s | 2,780 | 87.9% | 88.4c | -1.18c | -2.05 |
| feed delay +30s | 2,723 | 87.8% | 88.7c | -1.48c | -2.61 |
| band 75-85c | 996 | 78.3% | 80.2c | -2.96c | -2.51 |
| band 85-97c | 2,105 | 91.4% | 91.8c | -0.87c | -1.58 |
| the paper's period (R) | 467 | 90.6% | 88.6c | +1.33c | 0.94 |

- **No cell passes on its own**, so there is no candidate to re-test.
  NBA is the only positive league and is at t 1.71, under the bar.
- The paper's own period, scored with this rule, is +1.33c at t 0.94:
  the direction it reported, not significant, and gone in our windows.
  Read with the close-lag finding above, much of its late-game effect
  looks like measuring after the final whistle.
- **Full pass** (`--score`, same cache; 68,473 Kalshi requests, 258
  minutes) adds the rows below. None changes the verdict.

| cell | trades | won | paid | per contract | t |
|---|---|---|---|---|---|
| 6:00 left, +10s | 3,133 | 88.0% | 87.8c | -0.53c | -0.99 |
| 6:00 left, +5s | 3,192 | 87.3% | 87.7c | -1.14c | -1.98 |
| 6:00 left, +30s | 3,125 | 87.4% | 87.9c | -1.25c | -2.21 |
| 1:00 left, +10s | 2,142 | 88.1% | 88.4c | -0.97c | -1.44 |
| 1:00 left, +5s | 2,185 | 88.5% | 88.4c | -0.63c | -0.94 |
| 1:00 left, +30s | 2,038 | 88.6% | 88.7c | -0.78c | -1.17 |
| 10 min before the ACTUAL close, A + B | 770 | 95.1% | 88.4c | +5.95c | 5.94 |
| 10 min before the ACTUAL close, R | 74 | 94.6% | 89.9c | +4.08c | 1.68 |

  Every game-clock row is negative. The only strongly positive row is
  the paper's measure, timed off the market's actual close, which no
  trader can see coming; in window A it sits mostly after the final
  whistle for NBA, NHL and college basketball (close lag medians 14.8,
  32.4 and 30.0 minutes). That gap, +5.95c against -1.32c, is roughly
  what conditioning on the close is worth.
