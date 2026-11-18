# Favourites at halftime in sports games: plan, fixed before any data is read

Written 2026-11-18, at the user's request, after the late-favourite test
(`sports-late-plan.md`) FAILED at 3:00 left: 2,731 trades, -1.32c a
contract, t -2.31. The user asked whether the same idea works earlier:
at halftime, or further out.

**This is a second look at an idea that has already failed once, so the
bar is stricter than usual, and this is the last look.** No halftime
trade has been read. The 3:00-left result is known; the 6:00 and 1:00
reference rows of that test are being computed as this is written and
are not used to choose anything here.

## Hypothesis

At halftime, the side Kalshi prices at 75-97c wins more often than its
price says, by more than the taker fee. Why halftime could differ from
3:00 left: the break lasts 12-20 minutes, so no one is racing a feed;
the price is set by people looking at a score that cannot change until
play restarts, which is where a favourite-longshot lean would show if
there is one.

## The rule (one primary cell)

- **Leagues and games:** the same five series and the same joined games
  as the late test (NBA, NHL, NFL, college football, men's college
  basketball; joins already checked).
- **When:** the break after the first half. NBA, NFL, college football:
  after the 2nd quarter. Men's college basketball: after the 1st half.
  NHL has no halftime; its break is the **2nd intermission** (after the
  2nd period). Decision time = ESPN's wall-clock on the last play of
  that period **+ 60 seconds**.
- **What:** the first taker print in the **5 minutes** after the
  decision time, on either of the game's two Kalshi markets, that buys
  the side priced **75-97c**. That print's price is our price. No print
  in band within 5 minutes: no trade, counted.
- **Size and cost:** 10 contracts, Kalshi's taker fee (multiplier 1 on
  all five series), rounded up to $0.0001 per order. Held to
  settlement. One trade per game.
- **Windows:** A 2025-10-01..2026-02-28 and B 2026-09-01..2026-11-17,
  scored. R 2026-03-01..2026-05-31 printed for reference only, as
  before.

## Plumbing checks first (no trade or result read)

- the halftime decision is found for at least 95% of joined games per
  league (wall-clock present on the period's last play);
- the break, from that play to the first play of the next period, has a
  median between 10 and 25 minutes per league, and is longer than 6
  minutes in at least 90% of games (so the 5-minute look sits inside
  the break);
- the pre-game point below is found for at least 95% of games.

## The bar (PASS needs all three, A and B pooled)

1. Mean profit per contract after fees positive at **t >= 2.5** by day
   (stricter than the usual 2, because this is a second look).
2. Positive in **both windows**, A and B separately.
3. At least **200 trades**.

Printed as reference only, never a second chance:
- each league alone;
- bands 55-75c, 75-85c and 85-97c at halftime;
- **pre-game** ("further out"): the first in-band print in the 10
  minutes before ESPN's first play of the game;
- the end of the 3rd quarter (NBA, NFL, college football) and the NHL's
  1st intermission, same +60s and 5 minutes;
- window R.

## Stop rule

If the primary cell fails, favourites in sports games stop here: no
further time points, bands or leagues are tried on this data. A
reference row that would pass alone is recorded as a candidate for a
fresh test on games after 2026-11-17, and nothing more.

If it passes: a written plan for a 4-week paper record on live games
(decisions logged, no orders), then the trader at 10 contracts.

## What a pass would not show

- That 10 contracts were there at that price: a print is one trade.
- That fees stay where they are.
- That the break is the same live as in ESPN's record of it.

## Plumbing note, 2026-11-18 (no trade or result read): breaks read in feed order

The first plumbing pass took each period's earliest and latest
wall-clock. College football failed the break check (88.3% of breaks
over 6 minutes, p10 1.7 minutes) because ESPN's football feeds carry
stray stamps: a 2nd-quarter play stamped after the restart, a kickoff
stamped at exactly midnight UTC as a placeholder. Every other league
passed. Fixed before scoring, from ESPN data only: the break runs from
the period's **last play in feed order** to the next period's **first
play stamped after it**; a stamp of exactly 00:00:00 UTC is treated as
none; the pre-game point is the game's first play in feed order. This
applies to all five leagues. The rule, bar and windows are unchanged.

Re-run with the feed-order rule: every league clears.

| league | joined | halftime found | break p10 / median / p90 (min) | break > 6 min | other break | pre-game |
|---|---|---|---|---|---|---|
| NBA | 1,632 | 99.7% | 11.8 / 14.7 / 15.8 | 93.0% | 99.6% | 99.7% |
| NHL (2nd intermission) | 1,816 | 99.9% | 18.7 / 18.9 / 19.2 | 99.8% | 99.9% | 100.0% |
| NFL | 369 | 100.0% | 13.9 / 14.3 / 15.2 | 100.0% | 100.0% | 100.0% |
| college football | 1,858 | 99.1% | 19.9 / 21.0 / 22.8 | 98.5% | 99.7% | 99.9% |
| men's college basketball | 5,852 | 99.7% | 11.3 / 15.1 / 16.3 | 94.8% | — | 99.7% |
