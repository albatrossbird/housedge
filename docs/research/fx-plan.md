# FX trend and carry on the majors: plan, fixed before any data is read

Written 2026-11-27, test 1 of the scoreboard's queue. Only the start and
end dates of the series below have been read, to check they exist.

## Hypotheses

Two of the oldest documented currency effects, tested after the period
most papers used:
- **Carry:** currencies with higher short-term interest rates earn more
  than their rate difference loses through the exchange rate.
- **Trend:** a currency that has risen against the dollar over the past
  three months keeps rising more often than not.

A US account would trade these through OANDA US or CME FX futures, at
low cost. Two tests at once doubles the chance of a lucky pass, so the
bar is set higher than for one.

## Data (free, from FRED)

- **Daily noon rates against the dollar:** EUR (`DEXUSEU`), JPY
  (`DEXJPUS`), GBP (`DEXUSUK`), CAD (`DEXCAUS`), CHF (`DEXSZUS`), AUD
  (`DEXUSAL`), NZD (`DEXUSNZ`). Each is turned into the dollar value of
  one unit of the currency.
- **Monthly 3-month interbank rates** (`IR3TIB01<cc>M156N`) for the US and
  each of the seven.
  - Euro area and UK end in 2026-01. After that, their monthly means of
    the ECB deposit rate (`ECBDFR`) and SONIA (`IUDSOIA`) stand in.
  - Japan starts in 2002-04. Before that, Japan is left out of the carry
    ranking.

## The two rules (one primary cell each)

- **Position:** long or short a currency against the dollar, earning or
  paying the interest difference daily (foreign rate minus US rate,
  /365).
- **Signals** use data up to the previous close only.
- **Carry:** at each month end, rank the currencies by rate minus the US
  rate. Go long the top 2 and short the bottom 2 for the next month, each
  at a quarter of capital.
- **Trend:** each day, each of the seven is long if its past 63 trading
  days' return is positive, otherwise short, each at a seventh of
  capital.
- **Costs:**
  - 0.02% of the amount traded on every change in position, about 2 pips
    on the majors.
  - 0.5% a year on the gross position, for a broker's financing markup.
- **Scored period:** 2010-01-01 to 2026-11-20. Halves: 2010-2017 and
  2018..2026-11-20.

## The bar, per rule (PASS needs both)

1. Net Sharpe (daily returns, times the square root of 252) of **at
   least 0.5** over the scored period. That is higher than the 0.4 the
   long-run trend and carry literature reports, because two rules are
   being tried.
2. Net return **positive in both halves**.

Printed beside each: annual return and worst drawdown at 1x gross, and
the leverage that would run it at 10% annual volatility.

## Reference only (never a second chance)

- 1999-2009, the papers' era.
- Carry with the top and bottom 1 or 3 currencies.
- Trend lookbacks of 21, 126 and 252 days.
- Costs doubled.
- The two rules half and half.
- Each currency's trend alone.

## Stop rule

A rule that fails stops. A reference row that would pass alone is a
candidate for a forward test on days after 2026-11-20. A rule that
passes gets a paper record (weekly, like crypto trend), then a small live
account through the trader.

## What a pass would not show

- That OANDA's real financing matches the interbank difference. Its own
  rates and markup apply, and US accounts are capped at 50:1 leverage.
- Fills at the noon rate.
- That a well-known effect persists. Carry in particular crashes in
  risk-off weeks.
