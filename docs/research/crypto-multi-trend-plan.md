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
