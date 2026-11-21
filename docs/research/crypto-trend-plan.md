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
