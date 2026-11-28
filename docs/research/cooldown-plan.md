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

## Result, 2026-11-28: FAIL, and the cooldown is dropped

**The rule (primary period, 2026-09-01..10-28): FAIL.**

| | trades | won | per contract | t |
|---|---|---|---|---|
| rule with cooldown | 1,284 | 70.7% | -1.33c | -1.28 |
| first half (to 09-29) | 685 | 70.4% | -1.25c | -0.98 |
| second half (09-30..10-28) | 599 | 71.1% | -1.42c | -0.84 |

- It wins 71% of the time and pays about 71c a contract, so it loses the
  fee and a little more. It loses in both halves.
- **The $25 kill switch would have fired on 2026-09-06**, the sixth day.
  The period ended at -$85.17 at 5 contracts.

**The cooldown: DROP.** The 374 trades it skipped made **+3.03c** a
contract (t 1.65): +1.56c in the first half, +4.81c in the second. They
did better than the trades it kept, in both halves. Sitting out after a
loss removed the better trades, not the worse ones.

Plumbing cleared: 8,344 of 8,448 windows settled, Coinbase minute closes
for 99.99% of decision minutes, |Coinbase - strike| at the open p50
$10.34 and p90 $31.94.

Checks were once a minute (the description says every 30 seconds).
Checking twice as often changes when the rule buys, not what it pays
for a side that wins 71% of the time, so it is not re-run. Nothing goes
to the trader.

## Reference rows (never a second chance)

| row | trades | won | per contract | t |
|---|---|---|---|---|
| **their month, 10-29..11-27 (in-sample)** | 725 | 73.8% | +2.33c | 1.80 |
| no cooldown | 1,658 | 71.8% | -0.34c | -0.39 |
| band 5-95c (their best) | 2,325 | 82.9% | -1.72c | -2.87 |
| same, their month | 1,259 | 84.3% | +0.27c | 0.32 |
| band 32-95c | 2,325 | 82.9% | -2.05c | -3.43 |
| band 35-95c | 2,325 | 82.9% | -2.12c | -3.54 |
| band 5-78c | 1,210 | 69.2% | -0.43c | -0.40 |
| same, their month | 678 | 71.8% | +2.94c | 2.16 |
| band 5-80c | 1,284 | 70.7% | -0.63c | -0.61 |
| same, their month | 726 | 73.7% | +3.00c | 2.31 |
| distance $0 | 1,581 | 66.9% | -1.66c | -2.00 |
| distance $44 | 801 | 74.4% | +0.39c | 0.27 |
| move 0.01% | 1,402 | 70.8% | -1.37c | -1.39 |
| move 0.04% | 1,075 | 71.8% | -0.08c | -0.07 |
| first qualifying minute only | 1,172 | 71.2% | -0.96c | -0.91 |

By entry minute (primary rule): 5 min out -0.17c (707), 4 min -4.47c
(285), 3 min -0.26c (159), 2 min -1.33c (108), 1 min -5.01c (25).

- **Their month is positive in our data too** (+2.33c, t 1.80), so the
  replication is sound. It is the month that differs, not the reading.
- **No variant is positive in Sep-Oct except distance $44**, at +0.39c
  and t 0.27, which is noise. Their best band, 5-95c, is the worst
  outside their month (t -2.87). Picking a band on one month fitted that
  month.
- Without the cooldown, Sep-Oct is -0.34c: the cooldown cost a cent a
  contract there.

Kalshi requests: 57,569, of which 1,300 were refused and retried. A
request still refused after 8 tries would have stopped the run, so no
window is missing. 221 minutes.
