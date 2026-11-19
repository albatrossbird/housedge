# Funding carry on Kalshi's crypto perps: plan, fixed before any data is read

Written 2026-11-19, test 1 of `perps-survey.md`. No funding rate's level
has been read. One snapshot of all markets' latest rate scrolled past while
the endpoint was being found: 5 equity and crypto rows, BTC, ETH and SOL
not among them.

## Hypothesis

On Kalshi's crypto perps, longs pay shorts enough funding that a hedged
position, short the perp and long the same coins in spot, earns clearly
more than cash after costs. Why it could be: a new, retail-heavy venue
where buyers want leverage to the upside.

## The position

- **Coins:** BTC, ETH, SOL (`KXBTCPERP`, `KXETHPERP`, `KXSOLPERP`), each
  from its first funding print to the last print before 2026-11-19 00:00
  UTC. Equal dollar notional per coin.
- **Entry at the first print, exit at the last.** Short `N / mark`
  contracts at the print's mark price, and buy `contracts x
  contract_size` coins in spot at Coinbase's one-minute close at the same
  time. Held throughout, never rebalanced.
- **Funding:** at every print the short receives `rate x contracts x
  mark` (a positive rate means longs pay shorts; checked in plumbing).
- **Price:** short perp `contracts x (mark_entry - mark_exit)` plus spot
  `coins x (spot_exit - spot_entry)`, so only the change in the gap
  between them counts.
- **Costs:** Kalshi 12 bps of notional at entry and at exit (the reported
  entry-tier taker fee). Spot hedge 1.0% round trip.
- **Capital:** `2N` per coin. That is `N` of spot plus `N` posted as Kalshi
  margin (1x), so a rally cannot liquidate the short.

## Plumbing (no level of funding read)

- every coin has funding prints at 8-hour spacing with under 2% of
  periods missing;
- the perp mark per coin (`mark / contract_size`) is within 1% of
  Coinbase spot at 95%+ of prints. That checks the units;
- the sign: the rate should rise with the mark's premium over spot (the
  correlation of rate with premium is positive in each coin). If it is
  negative, the convention is the other way round and is flipped before
  scoring.

## The bar (PASS needs all three)

1. Pooled over the three coins, the net return on capital is at least
   **6% a year**. That is T-bills at about 4% plus 2 points for the risks
   in "What a pass would not show".
2. The pooled funding received, net of nothing, is positive in **both
   halves**: prints before 2026-09-01 and from 2026-09-01.
3. Funding received over the window is positive for **at least 2 of the 3
   coins**.

## Reference only (never a second chance)

- Each coin alone.
- Hedge at 0.1% round trip (a perp hedge on Coinbase instead of spot).
- Margin at `N/2`, capital `1.5N`.
- Every crypto perp's funding, annualized, gross (no hedge, no costs).
- Mean funding, annualized and gross, for each other asset class
  (equities, metals, energy, indices), toward survey test 3.

## Stop rule

If the primary fails, hedged carry on Kalshi's crypto perps stops. A
reference row that would pass alone is a candidate for a fresh forward
test on prints after 2026-11-18, nothing more. If it passes, survey test
2 next (the cheaper perp hedge), then a forward paper record before any
money.

## What a pass would not show

- That funding stays where it was. It is set by who is long, and that
  changes.
- The fee tier and the exact hedge cost (entry-tier figures are
  third-party; the fee endpoint needs a margin key).
- Venue risk: a new product, a CME lawsuit against its approval, and
  margin access still rolling out.
- Spot custody and transfer costs between the two venues.
