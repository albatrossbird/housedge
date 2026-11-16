# Resting orders for p75 on November: plan, fixed before the run

Written 2026-11-16, before the run. Open task 4 in `brief.md`.

## Question

p75 buys the favourite by crossing the spread and paying the taker fee
(about 0.6-1.3c a contract at 75-97c). Kalshi charges makers nothing on
KXBTC15M (`fee_type: quadratic`). Would the same decisions do better as
a resting bid at the touch?

The catch is selection: a resting bid fills when someone sells to it,
and if that is mostly just before the favourite loses, the saved spread
and fee are paid back in outcomes.

## The run

`backtest-15m.yml`, `source: archive`, `maker: true`, KXBTC15M, the last
16 days (2026-10-31 18:00 UTC onward: November to date), 10 contracts,
one strategy:

    {"p75":{"entry":{"side":"favourite","secsMin":15,"secsMax":45,"priceMin":0.75,"priceMax":0.97,"maxSpread":0.03}}}

It reads about 4GB of the recorded 15-minute archive from Storage.

Every decision the taker backtest makes is replayed as a bid at the
touch against every book change and trade of the final two minutes
(`lib/m15Maker.js`), three ways that bracket the truth:
- **join:** behind everyone already at that price (pessimistic);
- **front:** first in line (optimistic);
- **improve:** a cent inside a spread of 2c or more, else it joins.

## What is read

For each: the share filled, P&L per contract and per day against the
taker row on the same decisions, and **won when filled against won when
not filled**.

## Bar

Resting orders are worth a live trial only if all three hold:
1. **join** makes more in total than the taker on the same decisions;
2. **join** is positive;
3. its fills do not lose to selection: won-when-filled is not more than
   3 points under won-when-not-filled.

If join fails but front passes, the answer depends on queue position,
which only live orders can tell: reported as open, not as a pass.

**Otherwise stop:** resting entries are dropped for p75.

A pass is a candidate. It goes to the trader only as a small live trial
with its own review, and only if p75 is restarted at all.

## Not covered

Sharp-move is not in this run: its decisions live in
`scripts/m15-index.mjs`, which has no resting-order replay. Its edge is
being quick after a move, so a resting bid is a different trade.
