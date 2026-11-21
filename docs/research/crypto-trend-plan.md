# Crypto trend, long or flat: plan, fixed before any data is read

Written 2026-11-21, test 1 of `algo-survey.md`. No price series has been
read for this test.

## Hypothesis

Time-series momentum, one of the best-documented systematic effects,
holds in BTC and ETH after trading costs, out of the period the crypto
momentum papers studied. The concrete claim: owning a coin only while its
past 30 days were up gives better return for the risk than owning it all
the time.

## The rule (one primary cell)

- **Coins:** BTC and ETH, Coinbase daily candles (UTC days), half the
  capital each. Each coin's result is computed on its own and the two
  daily returns are averaged. The cost of rebalancing back to half and
  half is ignored, and is small.
- **Signal:** at each daily close, the coin's return over the past 30
  days. If it is above zero, hold the coin from this close to the next
  one. Otherwise hold cash. Cash earns nothing here, which is
  conservative.
- **Costs:** 0.40% of the amount traded on every switch between coin and
  cash (Kraken's reported entry-tier taker fee). No other slippage on the
  daily close.
- **Scored period:** 2021-01-01 to 2026-11-20, after the published
  crypto momentum samples end. Halves: 2021-01-01..2023-12-31 and
  2024-01-01..2026-11-20.

## The bar (PASS needs all three)

1. Net Sharpe (daily mean over daily standard deviation, times the square
   root of 365) of **at least 0.5** over the scored period.
2. A **higher Sharpe than buy-and-hold** of the same half-and-half
   portfolio. If holding does better, a bot adds nothing.
3. Net return **positive in both halves**.

Printed beside it: annual return, worst drawdown, time invested, the
number of switches, and buy-and-hold's figures.

## Reference only (never a second chance)

- Lookbacks of 7, 14, 60, 90 and 180 days.
- Fees of 0.10% and 0.80% a switch.
- Each coin alone; SOL from 2021.
- 2016-2020, the papers' own period.
- Long or short instead of long or flat (short through a perp at 0.12% a
  switch, funding ignored).

## Stop rule

If the primary fails, long-or-flat crypto trend stops on these coins. A
reference row that would pass alone is a candidate for a fresh forward
test on days after 2026-11-20, nothing more. If it passes: a paper record
on live daily closes for 8 weeks, then a small live bot through the
trader.

## What a pass would not show

- That the effect lasts: it is published and widely traded.
- Fills at the exact close, and fees below the entry tier.
- Tax: every switch is a taxable sale in a US taxable account.

## Result, 2026-11-21: PASS on the bar. Paper record next.

`node scripts/crypto-trend.mjs --score` (Coinbase daily closes, 34
public requests). Plumbing clears: BTC 4,142 days from 2015-07-20 with
none missing, ETH 3,837 days with 2 missing, SOL 1,983 days from
2021-06-17.

| 2021-01-01..2026-11-20 | Sharpe | a year | worst drawdown |
|---|---|---|---|
| **trend, long or flat, BTC + ETH** | **0.81** | 29.0% | -49% |
| buy and hold | 0.56 | 16.3% | -76% |
| trend, first half (2021-2023) | 1.06 | 48.8% | -49% |
| trend, second half (2024..2026-11) | 0.48 | 11.2% | -40% |
| buy and hold, first half | 0.75 | 32.4% | -76% |
| buy and hold, second half | 0.30 | 1.7% | -60% |

Invested 52% of the time, 346 switches across the two coins (about 29 a
year per coin). All three tests pass: Sharpe 0.81 against 0.5, above
buy-and-hold's 0.56, positive in both halves.

Reference rows (never a second chance):

- **Lookback:**
  - 7 days fails: -2.2% a year.
  - 14 days: 0.58. 60 days: 0.89.
  - 90 and 180 days (0.55, 0.53): about buy-and-hold.
  - So the effect is not one lucky lookback, but it is not uniform
    either: it lives between about two weeks and two months.
- **Fees:** 0.10% a switch gives 1.02; 0.80% gives 0.53.
- **Most of the gain is ETH.** ETH alone: 0.88 against its own
  buy-and-hold's 0.56. BTC alone: 0.51 against 0.50, no better than
  holding. SOL alone: 1.20 against 0.61.
- **2016-2020** (the papers' own period): 1.84 against buy-and-hold's
  1.56.
- **Long or short** through a perp at 0.12% a switch, funding ignored:
  0.86.

**How much this shows.** It is a pass on a fixed bar, not proof. Six
years of daily data puts a standard error of about 0.4 on a Sharpe, so
0.81 against 0.56 is not a significant difference on its own. The case
rests on three things together:
- the rule was fixed in advance, from the literature;
- it held after the papers' samples ended;
- nearby lookbacks agree.

What it mostly does is step aside during crashes: the worst drawdown
falls from -76% to -49%. The second half is much weaker than the first,
and -49% is still a crypto-sized loss.

**Paper record (the plan's next step):** re-scored weekly with `--last=`
on days after 2026-11-20. It checks plumbing and the daily decision. It
cannot confirm the edge, since a 30-day trend rule needs years for that.
At the 2026-11-20 close both coins are in cash (BTC -30.0% and ETH -34.5%
over 30 days).
