# Crypto trend across more coins: plan, fixed before any data is read

Written 2026-11-27, at the user's request, from the scoreboard's queue.
`crypto-trend-plan.md` passed on BTC + ETH. This asks whether the same
rule holds on coins it was never fitted or read on.

**BTC, ETH and SOL are left out of the scored set**: their results were
printed in the first test (SOL alone was a reference row there), so they
cannot test anything again. No price of any other coin has been read.

## Hypothesis

The 30-day long-or-flat trend rule beats holding on a basket of other
liquid coins after costs, out of the sample it was chosen on.

## Universe

Kalshi's crypto perp coins (`/margin/markets`, read 2026-11-19), minus
BTC, ETH and SOL: AAVE, ADA, BCH, BNB, DOGE, HYPE, LINK, LTC, NEAR, SHIB,
SUI, UNI, VVV, WLD, XRP and ZEC.
- A coin is in if Coinbase lists `<COIN>-USD` with daily candles.
  Plumbing says which are in.
- A coin joins the basket once it has 60 days of Coinbase history, so
  the 30-day signal has room.

## The rule (one primary cell)

- Each day, each coin in the basket holds itself if its past 30 days'
  return is above zero, otherwise cash. Capital is split equally across
  the coins in the basket that day.
- 0.40% of the amount traded on every switch, the same as the first
  test. Cash earns nothing.
- **Scored period:** 2021-01-01 to 2026-11-20, the same as the first
  test. Halves: 2021-2023 and 2024..2026-11-20.

## The bar (PASS needs all three)

1. Net Sharpe (daily, times the square root of 365) of **at least 0.5**.
2. Higher than **equal-weight buy-and-hold** of the same basket.
3. Net return **positive in both halves**.

## Reference only (never a second chance)

- Each coin alone, against its own buy-and-hold.
- Lookbacks of 14 and 60 days.
- Fee 0.12% a switch (Kalshi perps' reported taker fee).
- Long or short through the perps at 0.12% a switch, funding ignored.
- All 19 coins including BTC, ETH and SOL.

## Stop rule

If it fails, crypto trend stays a BTC + ETH rule only, and is watched in
its paper record. If it passes, the coins join the paper record (weekly,
`--last=`), and a live version goes to the trader only after the paper
record.

## What a pass would not show

- Survivorship: the universe is today's listed coins, which survived.
  Coins that died are missing, and they would have been held on the way
  down only until the 30-day return turned negative.
- Fills on smaller coins at the daily close, and fees below the entry
  tier.
- Tax on every switch.

## Result, 2026-11-27: PASS on the bar, narrowly. Paper record next.

`node scripts/crypto-multi-trend.mjs --score` (Coinbase daily closes, 240
public requests).

**Plumbing.** 15 of the 16 coins are in: AAVE, ADA, BCH, BNB, DOGE, HYPE,
LINK, LTC, NEAR, SHIB, SUI, UNI, VVV, WLD, ZEC. XRP is out under the
fixed rule: 904 missing days, Coinbase's 2021-2023 suspension during the
SEC case. The basket holds 4 coins on 2021-01-01, 11 on 2024-01-01 and
15 on 2026-11-20.

| 2021-01-01..2026-11-20 | Sharpe | a year | worst drawdown |
|---|---|---|---|
| **trend, long or flat** | **0.66** | 22.5% | -67% |
| equal-weight buy and hold | 0.58 | 14.4% | -87% |
| trend, 2021-2023 | 0.71 | 26.9% | -67% |
| trend, 2024..2026-11 | 0.60 | 18.0% | -55% |
| buy and hold, 2021-2023 | 0.55 | 8.7% | -87% |
| buy and hold, 2024..2026-11 | 0.62 | 20.6% | -63% |

All three tests pass: Sharpe 0.66 against 0.5, above buy-and-hold's
0.58, positive in both halves.

**Why "narrowly":**
- **The edge over holding is small.** 0.66 against 0.58 is well inside
  the noise of six years. In the second half the rule (0.60) did not
  beat holding (0.62).
- **What it reliably does is cut the drawdown:** -67% against -87%.
- **It loses on most coins alone.** Below their own buy-and-hold: AAVE
  (-0.02 vs 0.24), LINK (0.08 vs 0.44), LTC (-0.37 vs 0.19), BCH. Above
  it: ZEC (0.94 vs 0.88), SUI (0.90 vs 0.47), UNI (0.69 vs 0.51), NEAR
  (0.71 vs 0.48). The basket works through a few big trends and through
  sitting out crashes.
- **Survivorship flatters it.** These are today's listed coins.
- **Lookbacks:** 14 days 0.55, 60 days 0.59, both about holding. 30 days
  is not robustly better.

Other reference rows:
- **Fees matter most.** At 0.12% a switch (Kalshi perps' reported taker
  fee), Sharpe is 0.82 against 0.66 at 0.40%. Holding a perp long pays
  funding, which this ignores.
- **Long or short** through perps, funding ignored: 0.51, worse than
  long or flat. Shorting alts on a 30-day signal adds nothing.
- **All 18 coins including BTC, ETH and SOL:** 0.80 against 0.61
  holding.

**Reading.** Together with `crypto-trend-plan.md`, the evidence says the
30-day rule mainly avoids crashes, a little better than holding on a
broad basket, and best on BTC + ETH. The paper record now covers both,
weekly with `--last=`.
