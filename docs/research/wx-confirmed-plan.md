# Weather outcomes the observations already confirm: plan, fixed before any data is read

Written 2026-11-26, test 2 of `strategy-survey.md` and of `algo-survey.md`'s
queue. No price and no settlement of a weather market has been read for
this test. Market close times were read to find where the series begin.

## Hypothesis

A day's high can only go up. Once a station has already recorded a
temperature above a bracket, that bracket's NO (and a "greater than"
market's YES) is settled in all but name. The question is whether that
side can still be bought below about 97c after the observation is
public, by enough to beat the fee.

## Markets and data

- **Markets:** Kalshi's daily-high series for US cities (`KXHIGH*`)
  whose rules name a CLI code in `lib/weather.js`'s `CLI_TO_STATION`.
  Kalshi settles them on The Weather Company's recorded maximum, in whole
  degrees F. Fee: quadratic, multiplier 1 (read from `/series` on
  2026-11-26), at 10 contracts rounded up to $0.0001.
- **Observations:** the Iowa Environmental Mesonet's public archive of
  the same station's routine reports (`tmpf`), timestamped when observed.
- **The day:** midnight to midnight local STANDARD time, the climate-day
  convention, so during daylight saving it runs 1 AM to 1 AM clock time.
- **Windows:** A 2026-02-01..2026-06-30, B 2026-07-01..2026-11-24. Both
  scored.

## The rule (one primary cell)

- **Running max:** `V` = the day's highest report so far, rounded to a
  whole degree.
- **Confirmed** means the settled high is already at least `k` with a
  1-degree margin: `V >= k + 1`.
  - a "greater than f" market's YES (needs a high of `f + 1` or more)
    when `V >= f + 2`;
  - a bracket `[a, b]`'s NO when `V >= b + 2`;
  - a "less than c" market's NO when `V >= c + 1`.
- **Decision:** the time of the first report that confirms the market,
  **+10 minutes** (publication lag).
- **Entry:** the first taker print in the next **60 minutes** that buys
  the confirmed side at **97c or less**. That print's price is ours. No
  such print: no trade, counted.
- **Size:** 10 contracts, held to settlement. At most one trade per
  market.

## Plumbing (no price or P&L read)

1. At least 90% of the markets' station-days have reports in 20 or more
   distinct local hours.
2. **The instrument check.** Over every market the rule confirms at any
   point in the day, the settlement goes against the confirmed side in
   **at most 0.5%** of markets. This reads settlements against
   observations only, never a price.
   - If the 1-degree margin fails it, the margin is 2 degrees.
   - If 2 also fails, the test stops: our observations do not stand in
     for The Weather Company's.

## The bar (PASS needs all three)

1. Mean profit per contract after fees positive, **t >= 2** by day, A and
   B pooled.
2. Positive in A and in B separately.
3. At least **200 trades**.

## Reference only (never a second chance)

- Margin 0 and 2 degrees.
- Delay 0 and 30 minutes.
- Price caps of 95c and 99c.
- Each city.
- The share of confirmed markets with any print at 97c or less, and how
  long after confirmation the first one comes.

## Stop rule

If the primary fails, buying confirmed weather outcomes stops. A
reference row that would pass alone is a candidate for a fresh test on
days after 2026-11-24. If it passes, the next step is a paper record from
the box's weather recorder (book depth at decision time), then the
trader.

## What a pass would not show

- **Size:** a print is one trade.
- **Speed:** whether reports reach us 10 minutes after they are
  observed.
- **The settlement source:** The Weather Company's figure is not ours,
  and the instrument check measures the gap only on past days.
