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
