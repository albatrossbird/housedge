# Crypto bots and perps: what could be built, and what is worth testing

Written 2026-11-19, at the user's request: could a crypto trading bot, or a
perpetual-futures bot on Kalshi, make money, and how should this project
go further into algorithmic trading?

## What we already have

- **A crypto bot already trades.** p75 and sharp-move are rules on Kalshi's
  15-minute crypto markets, built and measured here (`m15.md`) and run by
  the trader. They are the only two of the rules tested here that reached
  real orders.
- **The WebSocket plumbing exists.** The recorder box runs Kalshi's
  authenticated WebSocket for the 15-minute markets, without
  permessage-deflate (`lib/plainWebSocket.js`). A perps channel needs the
  same kind of client.
- **Most ideas fail.** Market making on reward markets, late favourites in
  sports, halftime favourites, the volatility flag, faster entries and
  resting orders for p75 all failed on our own data. That is the base
  rate to expect.

## What the outside evidence says

- **Most retail active traders lose.** The best-documented studies are of
  day traders in Brazilian futures (about 97% of those who kept at it
  lost) and on the Taiwan exchange (under 1% earned persistent profits
  after fees). No rigorous study measures retail crypto bots. Vendor
  numbers are marketing, not evidence.
- **The crypto basis has shrunk.** BTC perp funding and the futures basis
  ran 20-40% a year in early 2024 and about 3-5% in 2026, with a negative
  quarter. That is near or below T-bill rates, so a hedged carry trade
  barely beats cash on the large venues. The premium has moved to equity
  perps, about 11% a year on the largest ones in 2026.

## The venues a US account can use

- **Kalshi perps** went live 2026-06-03 (BTC), after CFTC approval.
  - On 2026-11-19 `/margin/markets` lists 126 perps: 19 crypto, 94
    equities, 6 metals, 4 energy and 3 indices.
  - Crypto funds every 8 hours (12 AM, 8 AM and 4 PM Eastern), capped at
    2% a period. Margin is isolated. The leverage estimate is 6.3x on BTC,
    4.4x on ETH and 3.1x on SOL.
  - Third-party sources put fees at 12 bps taker and 5 bps maker on
    notional at the entry tier, falling with volume. This is unverified:
    the fee endpoints need a margin-enabled key.
  - **Market data is public.** `external-api.kalshi.com/trade-api/v2/margin/markets`
    (book top, open interest, volume) and
    `/margin/funding_rates/historical?ticker=<T>` (every funding
    print since launch, with the mark price) answer with no key. The perps
    WebSocket and the order endpoints need one. Production margin access
    is rolling out member by member.
- **Coinbase perps for US customers** have been live since 2025-07 (nano
  BTC and ETH at first). Funding accrues hourly, leverage is about 10x,
  and API fees are reported near 0% maker and 0.03% taker. Unverified.
- Offshore perp venues are not open to US persons and are out of scope.

## Candidate tests, in order

1. **Funding carry on Kalshi's crypto perps** (`perps-carry-plan.md`).
   Short the perp on Kalshi and hold the same coins in spot, so the price
   cancels and the funding is the return. A newer, retail-heavy venue may
   pay longs' funding above the big venues' 3-5%. This needs only public
   data that already exists: Kalshi's funding history and Coinbase's
   public candles. **FAILED 2026-11-19**: 1.21% a year on capital, below
   cash (BTC alone 4.44%). Kalshi's crypto funding is not above the big
   venues'.
2. **Funding gap, Kalshi against Coinbase perps.** Dropped with (1): it
   was to run only if (1) showed Kalshi's funding running high, and it did
   not. Had it, hedge with Coinbase's perp instead of spot. That
   is cheaper to hold, and the return is the difference between the
   venues. It needs Coinbase's funding history (not yet checked).
3. **Equity perps' funding** (94 markets). This is where the outside
   evidence says the premium now sits. Kalshi listed them on 2026-11-05;
   about three months of prints are needed first. A hedge needs the stock at a
   broker, and stock hours differ from perp hours. Printed as reference in
   (1) first; its own plan only if the reference rows warrant one.
4. **Price gaps between Kalshi's perp and spot.** A latency trade. Our
   speed test found faster entries did worse on the 15-minute markets, and
   12 bps a side is a high bar for a gap. It needs recording first (perps
   WebSocket, keyed), so it comes after the public-data tests.
5. **A directional bot** (trend or mean reversion) on BTC/ETH. Free data
   goes back years, so it is cheap to test honestly. The outside evidence
   and the fees make a pass unlikely, but one fixed-in-advance test would
   settle it for us.

Every test follows the standing rules: plan and bar fixed before the
data, upper bounds, and no profit promises.
