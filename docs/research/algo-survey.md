# Algorithmic trading beyond Kalshi's event markets: venues, strategies, a test queue

Written 2026-11-21, at the user's request. The goal is many small bots
on many strategies, each one passing its own test first. The user's rule
applies: no stock-market trading (no stocks, equity or index futures and
perps, or stock options).

## Where crypto stands (2026-11-21)

- **Live:** p75 and sharp-move, the two rules on Kalshi's 15-minute
  crypto markets (`m15.md`), run by the trader.
- **Failed:** funding carry on Kalshi's crypto perps (`perps-carry-plan.md`):
  1.21% a year on capital, below cash.
- **Passed its bar:** crypto trend, long or flat (test 1 below), in a
  paper record.

## Venues a US account can trade by API (fees to be confirmed on each
venue's own page; third-party figures disagree)

| market | venue | API | costs and limits |
|---|---|---|---|
| crypto spot | Kraken | REST, WebSocket, FIX | entry tier reported 0.25% maker / 0.40% taker |
| crypto spot, US perps | Coinbase Advanced | REST, WebSocket | spot reported 0.40-0.90% taker at entry; perps near 0 maker / 0.03% taker |
| crypto, metals, energy perps | Kalshi | REST, WebSocket (keyed) | reported 12 bps taker at entry; margin access rolling out |
| spot FX | OANDA US | REST v20, streaming, FIX | leverage capped at 50:1 on majors, 20:1 others; FIFO and no hedging in one account |
| futures (FX, rates, metals, energy, crypto) and their options | CME, through a futures broker's API | broker-specific | exchange plus broker fees per contract; index futures excluded by the no-stocks rule |
| event contracts | Kalshi, Polymarket US | in use | measured in `m15.md` and CLAUDE.md |

Crypto options for US retail are thin: CME's bitcoin options through a
futures broker. The large crypto options venues serve non-US customers.

## Strategy families, and what the evidence says

| family | the idea | evidence | where | testable on free data? |
|---|---|---|---|---|
| **Trend (time-series momentum)** | own what has been rising, step aside from what has been falling | the best-documented systematic premium: 58 futures markets, decades, about 0.4 Sharpe a decade on long history; crypto studies find it survives costs | crypto, FX, commodity futures | yes (daily prices) |
| **Carry** | hold the higher-yielding side, paid to wait | FX carry is long-documented, with crash risk; crypto funding carry failed here | FX, futures term structure | FX: yes (central-bank rates and daily FX) |
| **Volatility selling** | sell options, collect the gap between implied and realised volatility | a variance premium exists in bitcoin, larger than in stocks; tail losses are the cost | CME bitcoin options | needs options data (not free) |
| **Mispricing in small venues** | event markets priced wrong by slow or biased traders | our own live rules; most such ideas failed in testing | Kalshi, Polymarket US | yes, and in the queue (weather, bracket sums) |
| **Cross-venue gaps** | the same thing priced differently in two places | arbitrage is real and mostly taken by faster players | Kalshi vs Polymarket, perp vs spot | needs recording |
| **Market making** | quote both sides, earn the spread | needs speed and inventory control; failed here on reward markets | any | needs recording |

**Why many bots:** small edges that do not move together add up more
steadily than one large bet. A trend bot does best in big moves, a carry
bot in quiet ones, an event-market bot on neither. That is how
systematic funds run. Each bot still has to pass alone, and the portfolio
needs shared caps: a per-bot loss stop, a total exposure limit, and a
paper record before any money.

## The test queue (each with a plan fixed before its data)

1. **Crypto trend, long or flat** (`crypto-trend-plan.md`). **PASSED its
   bar 2026-11-21**: Sharpe 0.81 against buy-and-hold's 0.56 over
   2021..2026-11, worst drawdown -49% against -76%, mostly from ETH.
   Paper record running.
2. **Weather outcomes confirmed by observations** on Kalshi
   (`strategy-survey.md`).
3. **FX trend and carry** on the majors. Daily FX and central-bank rates
   are free, and OANDA's costs are low enough for a slow strategy.
4. **Bracket sums** on slow Kalshi markets.
5. **Trend across CME futures** (metals, energy, rates, FX futures):
   the classic multi-market version of test 1. It needs a futures data
   source.
6. **Bitcoin volatility selling** on CME options. It needs bought data
   and a careful look at tail losses.
7. **Kalshi perp against spot gaps**: it needs a keyed recorder.
