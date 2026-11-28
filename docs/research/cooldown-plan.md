# A posted KXBTC15M rule with a three-market cooldown: plan, fixed before any data is read

Written 2026-11-28, at the user's request, from a rule a trader published
(the trader is not named here, per the standing rule). The parameters are
theirs, not chosen by us, so nothing here is fitted. No price or result
for this test has been read.

## Their rule, as we read it

- **Market:** Kalshi `KXBTC15M`. YES resolves if the 60-second BRTI average
  at the close is at least the strike (`floor_strike`, the average at the
  open).
- **Entry:** Coinbase BTC-USD is at least **$22 past the strike** and its
  **5-minute move is at least 0.02%** in the same direction.
  - Above the strike and rising: buy YES.
  - Below it and falling: buy NO.
- **Price:** buy that side if a taker print shows it at **32c to 80c**.
- Held to settlement.
- **Cooldown:** after a trade that loses money after fees, sit out the
  **next three markets**.

## How we test it (one primary cell)

- **Prices:** Coinbase one-minute closes (public).
- **When:** the rule is checked at each minute close inside the window,
  minutes 1 to 14. At the first minute both conditions hold, the decision
  time is that close +2 seconds, and the entry is the first taker print in
  the next **60 seconds** buying that side at 32-80c. If there is none,
  the next minute where the conditions hold is tried.
- **Size and cost:** one trade per market, 10 contracts, taker fee
  (quadratic, multiplier 1, read from `/series` 2026-11-28), rounded up to
  $0.0001.
- **Window:** 2026-09-01 to 2026-11-27 (market close times). Halves split
  at 2026-10-15.

## The bar

**The rule** (PASS needs all three):
1. Mean profit per contract after fees positive at **t >= 2** by day.
2. Positive in both halves.
3. At least **200 trades**.

**The cooldown** is a skip rule, so it is judged on the user's bar for
skips. The trades the cooldown removes must:
- lose at **t <= -1**;
- **and** do worse per contract than the traded ones, in both halves.

Otherwise the cooldown is dropped. That answers the poster's own
question: does stopping after a loss carry an edge, or is it a band-aid?

## Reference only (never a second chance)

- No cooldown.
- Their best band, 5c to 95c.
- Distance $0 and $44.
- Move 0.01% and 0.04%.
- The first qualifying minute only, with no later retries.

## Stop rule

If the rule fails, it stops, and nothing about it goes to the trader. If
it passes, the first question is how much it overlaps sharp-move, which
also buys BTC 15-minute sides on a fresh move. A paper record follows
only if it is not the same trades.

## What a pass would not show

- Size: a print is one trade.
- That Coinbase's minute close is what a live feed shows at that moment.
  The index that settles the market is BRTI, not Coinbase.
- That the poster's period behaves like ours.

## Amendment, 2026-11-28, before any result was read

The user found the rule's own published description, with variants.
The first scoring run was stopped and its output was not read. Where the
description is more exact than the Reddit post, it replaces our reading
above.

**The rule, from its description:**
- **Entry window:** checks every 30 seconds, and enters only with
  **between 60 seconds and 5 minutes to expiry**.
- **YES:** buy 5 contracts when flat, the **YES ask is 32-80c**, the
  spot gap from strike (Coinbase minus strike) is at least +$22, and the
  Coinbase 5-minute change is at least +0.02%.
- **NO:** the mirror. NO ask 32-80c, gap at most -$22, change at most
  -0.02%.
- **Orders:** immediate-or-cancel, one per market.
- **Cooldown:** skip while the last settled traded window lost money and
  fewer than three windows have finished since that trade.
- **Kill switch:** a $25 total loss halts the run.
- **Their backtest:** 2026-10-29 to 2026-11-27. Their ten-plus variants
  differ only in the price floor and ceiling, all picked on that month.
  Best: 5-95c, +$537.29, 83% won.

**Our test, amended:**
- **Checks:** at the minute closes 5, 4, 3, 2 and 1 minute before
  expiry. Coinbase's public candles are one-minute, so this is half the
  description's 30-second checks.
- **Entry:** the first taker print in the next 60 seconds that buys the
  side at 32-80c stands in for the ask they would have hit.
- **Size:** 5 contracts.
- **Primary period: 2026-09-01 to 2026-10-28,** the months their
  variants never saw. Halves split at 2026-09-30.
- **Their own month** (2026-10-29..11-27) is printed as reference only.
  It is in-sample for them.
- **The bar is unchanged:** t >= 2 with 200+ trades, positive in both
  halves. The cooldown is judged on the skip-rule bar within the primary
  period.

**Added reference rows:**
- Whether the $25 kill switch would have fired in our period.
- Their top variants' bands: 5-95c, 32-95c, 35-95c, 5-78c and 5-80c.
