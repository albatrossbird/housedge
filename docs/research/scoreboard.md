# Strategy scoreboard

Every strategy this research has tested, and where it stands. Run like a
fund's book:
- ideas enter the queue;
- each one gets a plan fixed before its data;
- a pass goes to a paper record, then small live size through the
  trader;
- a fail is recorded and stopped.

Figures are backtest upper bounds unless marked live. Detail is in the
linked plan or in `m15.md`. Update this page whenever a status changes.

## Live (through the trader)

| strategy | market | status | key figure | doc |
|---|---|---|---|---|
| sharp-move | Kalshi BTC 15-minute | live at 10 contracts since 2026-11-17; review at 300 settled | +1.53c a contract live, t 1.28 on 419 at the restart | `restart-plan.md`, `m15.md` |
| p75 (with time filters) | Kalshi BTC 15-minute | live at 10 contracts since 2026-11-17; review at 300 settled; filters scored to ~2027-01-12 | edge stop fired once (2026-11-14); restarted with filters | `restart-plan.md`, `m15.md` |

## Paper or forward record

| strategy | market | status | key figure | doc |
|---|---|---|---|---|
| crypto trend, long or flat | BTC + ETH spot | passed its bar 2026-11-21; weekly paper record | Sharpe 0.81 against 0.56 holding (2021..2026-11), worst drawdown -49% against -76% | `crypto-trend-plan.md` |
| crypto trend, 15 more coins | AAVE, ADA, BCH, BNB, DOGE, HYPE, LINK, LTC, NEAR, SHIB, SUI, UNI, VVV, WLD, ZEC | passed its bar narrowly 2026-11-27; weekly paper record | Sharpe 0.66 against 0.58 holding; worst drawdown -67% against -87%; loses to holding on most coins alone | `crypto-multi-trend-plan.md` |
| college basketball leader, 1:00 left | Kalshi game markets | candidate; weekly forward re-score | 2 of 2 won so far; fails at a second loss, passes at 45 straight or at most 1 loss in 60 | `sports-margin-plan.md` |

## In test

Nothing at the moment.

## Failed and stopped

| strategy | market | result | doc |
|---|---|---|---|
| a published 15-minute rule with a cooldown after losses | Kalshi BTC 15-minute | -1.33c a contract, t -1.28 on 1,284 trades (Sep-Oct); the skipped trades did better | `cooldown-plan.md` |
| FX carry (top 2 / bottom 2 majors) | spot FX vs USD | Sharpe 0.09, 2010..2026-11 | `fx-plan.md` |
| FX trend (63 days, 7 majors) | spot FX vs USD | Sharpe -0.27, negative in both halves | `fx-plan.md` |
| weather outcomes already confirmed | Kalshi daily highs, 24 US cities | 4 tradeable of 9,076 confirmed markets: priced at 97c+ within minutes | `wx-confirmed-plan.md` |
| late favourites (3:00 left) | Kalshi sports games | -1.32c a contract, t -2.31 | `sports-late-plan.md` |
| favourites at halftime | Kalshi sports games | -1.18c, t -2.21 | `sports-half-plan.md` |
| leader by lead and price | Kalshi sports games | too few trades to test except one candidate (above) | `sports-margin-plan.md` |
| funding carry | Kalshi crypto perps | 1.21% a year on capital, below cash | `perps-carry-plan.md` |
| market making for liquidity rewards | Kalshi | rewards real; fills on ending markets lost more | `mm-plan.md` |
| resting orders for p75 | Kalshi BTC 15-minute | fail | `maker-plan.md` |
| ladder consistency (BTC brackets) | Kalshi BTC | gaps last ~5ms; no fill | `ladder-step2-plan.md` |
| volatility flag; faster entries; overlap skips | Kalshi BTC 15-minute | fail | `vol-flag-plan.md`, `speed-plan.md`, `m15.md` |

## Queue (next first)

1. Bracket sums on slow Kalshi markets.
2. Trend across CME futures: metals, energy, rates (no index futures).
   FX trend failed, so this needs commodities to carry it.
3. Bitcoin volatility selling on CME options (needs bought data).
4. Kalshi perp against spot gaps (needs a keyed recorder).

Sources for new ideas: academic papers, venue launches (new markets are
least efficient early), our own recorders, and what other traders
publish, which is checked, never trusted. No stock-market strategies
(the user's rule).
