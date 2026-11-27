# Research session brief

Written 2026-11-13, when trading research moved out of the MarketSlap
session into a session of its own. The MarketSlap session handles the
site, accounts, billing and the sports board. This session handles the
15-minute market research, the recorder box and handoffs to the trader.
Update this file when the live state changes: it is the first thing the
next session reads.

The measurements behind everything here are in `docs/research/m15.md`.

## Who is who

- **The user** owns MarketSlap and relays messages between this session
  and the trader. Keep answers concise. They are on Windows (no Mac
  steps), and they are careful with money.
- **The trader** runs the live bots on a separate box. We have no access
  to that box. Messages arrive pasted as `TRADER → RESEARCH: ...` and
  go back as a paste-ready block headed
  `RESEARCH → TRADER: <topic> (<date>)`.
- **The trader changes nothing unless we send it as a rule change.**
  Handoffs carry rules and measurements, never code from their box or
  keys.

## Live state (2026-11-14)

**Both rules are STOPPED** since 2026-11-14 19:31 UTC: p75's edge stop
fired (302 settled, -0.43c), and by the trader's daily figures
sharp-move's $100 drawdown stop had fired too. We recommended retiring
p75 from live and not restarting sharp-move at 40. Both backtests lost
on the same windows (m15.md "2026-11-14"). Nothing restarts without a
rule change from us. What follows is the state as it stood before the
stop.

On KXBTC15M only. Gold, the other coins and the shadow rules are retired.
- **p75:** the favourite at 75-97c, decided once a second 45s to 15s
  before the close, held to settlement. 40 contracts.
- **Sharp-move:** `lib/sharpMove.js`. The first 1bp BRTI move in a
  second, 118s to 6s out, on a two-sided book with mid 0.15-0.85, limit
  at the price seen +1c, held to settlement. 40 contracts since
  2026-11-13 13:12 UTC.
- **Automatic step back to 20:** if the box's burst-capacity alarm (20%)
  fires, or the median from the deciding CF stamp to Kalshi's receipt
  over the last 10 orders since the size was set is above 100ms.
- **Review bar at 40, over the first 30+ orders:** median under 100ms,
  p90 under 250ms, fill rate near the backtest's ~80% on the same
  windows.
- **Sharp-move overall review at 300 settled:** stop at t <= -1 or a
  $100 drawdown.
- **The trader's box:** the book is subscribed 180s before each close and
  cancelled at the close. Only changes the bot reads are forwarded. CPU
  is ~6% of a core (it was ~35%, which ran the box out of burst credit
  from 11-02 and caused the slow fills).
- **The fee check:** split-level fills are checked against the formula
  summed per level and rounded once (fixed 11-12). We asked for the
  11-11 40-contract fill and the 10-19 10-contract fill to be pinned as
  test cases, and for a fee KILL to alert at once.

## Standing rules

**Doing research**
- Fix the hypothesis, the pass bar and the stop rule in code or in
  writing BEFORE the run. Score on days the idea was not found on.
  A cell chosen after the fact is a candidate to re-test, never a
  finding.
- Every backtest figure is an upper bound. Never present one as profit,
  and never make a profit promise.
- Run analysis workflows one at a time (they share the `m15-analysis`
  queue), and never 15:45-16:45 UTC, when discovery and matching load
  the database. Mind Storage egress: say what a run will read before
  re-running a large archive read.
- Run new analysis from the branch first. Merge the code with the
  result, squash-merged.
- **No stock-market trading** (the user, 2026-11-19): no stocks, equity
  perps or stock-index products, as research targets or trades.

**Data and secrets**
- Recorded and downloaded Kalshi data is private. Never make the
  `stream-archive` bucket public, never add a read policy, never commit
  recorded data (`.tape-cache/` and `.binance-sharp/` are gitignored).
  The sharp-move fixture stays in private repositories and on the trader
  box. The same applies to CME data bought from Databento.
- Research code never loads `/etc/marketslap/env`.
- Secrets go only in Vercel or GitHub repository secrets, never in chat,
  code or logs. The Databento key is the repository secret
  `DATABENTO_API_KEY`, never printed. Never install the Synpath SDK on
  the box or the trader machine.
- **The box's .us key can trade.** Refer to it only as "the box's .us
  key". Never put it in a repo, an environment variable, a log or chat.
  Never name or describe the other service or where the key came from.
  MarketSlap code must never call an order endpoint;
  `scripts/no-order-endpoints.test.mjs` stays.
- Do not name, in the repo or anything published, the vendors whose
  strategies are researched.

## Open tasks (rewritten 2026-11-16)

**Live (restarted 2026-11-17, built as the trader's PR 33)**
- sharp-move at 10 contracts, no filter, $100 drawdown from the
  restart's high; p75 at 10 contracts, no order 16:00-19:59 New York or
  on Saturday/Sunday, $75 drawdown. Both: t <= -1 at 300 settled stops
  it; $50 daily loss cap each (the trader's). No cross-rule. Final
  message and the trader's answers: `restart-plan.md`.
- At the restart: p75 live split agreed with the filters ((a) -7.82c,
  (b) +6.56c; not independent); sharp-move live +1.53c, t 1.28 on 419.

**Running**
- **p75's filters, scored on the tape** from 2026-11-17 for 8 weeks
  (to about 2027-01-12): a filter is dropped if its skipped windows make
  more per contract than the traded ones; confirmed only at t >= 2.
- **The 300-settled reviews**: sharp-move in about 18 days, p75 in
  about 33. Ask the trader for settled count, mean per contract and t.

**The bar for a skip rule** (the user's, 2026-11-16): t <= -1 against
the rest, the skipped trades losing money themselves, and worse in both
halves. Adding size or trades stays at t 2. See `restart-plan.md`.

**Done**
- Ladder step 2: STOP at day 3 (run 44208436894): 144 gaps, median life
  5ms, no two-legged fill from +25ms. The user turns the recorder off
  (`sudo systemctl disable --now marketslap-ladder-stream.service`).
- Ladder step 1, the tape: passed its screen (m15.md "Ladder
  consistency").
- What speed is worth: nothing below 100ms for sharp-move (m15.md).
- Volatility flag: fails on both rules (m15.md).
- Time of day: no filter for sharp-move; two candidates for p75.
- Both rules in one window: independent day to day (correlation
  -0.02); no cross-rule. An "against sharp-move" skip failed once
  lookahead was removed.
- Sharp-move tweaks: current settings at or near the best row; size is
  the only clean risk lever.
- Resting orders for p75 on November: FAIL, dropped (`maker-plan.md`).
- Market making where Kalshi pays for it (`mm-plan.md`): Part A passed
  (sweep 1: $200 a market paid a median $0.62-0.76 a day before fills);
  Part B FAILED on the ended sample: 282 settled markets lost $4,560
  with reward included, still -$1,793 at the richest share. Rich pools
  sit on markets whose endings run a resting quote over. Stopped.
- Sharp-move midnight to 4am New York time, over four months on the
  stand-in: +3.47c a contract on 188 fills against +1.80c for the rest
  (t +0.48). Fails all three skip tests; no skip (`restart-plan.md`).
- Late favourites in sports games on the game clock
  (`sports-late-plan.md`, 2026-11-18): FAIL. 2,731 trades at 3:00 left,
  -1.32c a contract at t -2.31, negative in both windows; favourites won
  as often as priced and the fee is the loss. No league passes alone.
  Stopped. Found on the way: Kalshi closed NBA, NHL and college
  basketball markets 15-30 minutes after the game until mid-2026.
- Buy the leader late, by lead and price (`sports-margin-plan.md`,
  2026-11-18): FAIL. Chosen on A, tested once on R + B. Only men's
  college basketball had a cell to test (1:00 left, lead >= 6,
  50-95c). On R + B it won 16 of 16, too few against the 60-trade bar.
  Stopped. One candidate is recorded: re-score that exact rule on games
  after 2026-11-17 once there are 60 trades, allowing at most 1 loss.
- Favourites at halftime (`sports-half-plan.md`, 2026-11-18): FAIL.
  4,677 trades, -1.18c a contract at t -2.21, negative in both windows
  and in every league. That was the last look: favourites in sports
  games stop.
- Funding carry on Kalshi's crypto perps (`perps-carry-plan.md`,
  2026-11-19): FAIL. Short perp plus long spot on BTC, ETH and SOL from
  launch: 1.21% a year on capital, below cash. BTC alone 4.44%. The
  funding is about the big venues', not above it. Survey of crypto and
  perp bots: `perps-survey.md`.
- Crypto trend, long or flat (`crypto-trend-plan.md`, 2026-11-21): PASS
  on its bar. BTC + ETH, hold while the past 30 days are up, else cash,
  0.40% a switch: Sharpe 0.81 against buy-and-hold's 0.56 over
  2021..2026-11, worst drawdown -49% against -76%. Second half weaker
  (0.48). The gain is mostly ETH; BTC alone matches holding. Paper record
  weekly. Wider survey and queue: `algo-survey.md`.
- Weather outcomes already confirmed by observations
  (`wx-confirmed-plan.md`, 2026-11-26): FAIL. The free station reports
  match Kalshi's settlement (2 against of 9,076). But only 4 confirmed
  markets offered a print at 97c or less after a 10-minute delay; 88 did
  in the first 10 minutes. It is a speed race, too small to chase.
  Scoreboard of every strategy: `scoreboard.md`.
- FX trend and carry on the majors (`fx-plan.md`, 2026-11-27): both
  FAIL over 2010..2026-11. Carry Sharpe 0.09 (top 2 long, bottom 2
  short, monthly). Trend -0.27 (63 days, all seven), negative in both
  halves. Both worked better in 1999-2009 (carry 0.35).
- Crypto trend across 15 more coins (`crypto-multi-trend-plan.md`,
  2026-11-27): PASS on its bar, narrowly. Sharpe 0.66 against 0.58
  equal-weight holding, worst drawdown -67% against -87%. Second half
  0.60 against holding's 0.62, and below holding on most coins alone.
  The rule mainly sits out crashes. BTC, ETH and SOL were left out
  (already read). Paper record weekly.

**Candidates, not started**
- **College basketball, 1:00 left, lead >= 6, 50-95c**: forward
  record running weekly from 2026-11-18 (`sports-margin-plan.md`).
- **Next tests, in order** (`scoreboard.md` Queue): bracket sums on slow
  markets; trend across CME futures (no index
  futures); bitcoin volatility selling on CME options; Kalshi perp
  against spot gaps.
  Equity and index perps are dropped: no stock-market trading.
- **Quoting a liquidity-reward market only until its outcome starts to
  arrive** (from the market-making study's FAIL): untested. Knowing
  when to stop is the whole edge; it needs its own plan.
- **p75's 75-85c band:** its November re-test is spoiled through 11-14
  (it was printed). Fair test: days after 11-14.
- **The BTC 2-minute underdog at 3-20c:** November re-test, to be fixed
  before scoring.

## How to start

Read this file, then the sections of `docs/research/m15.md` a task
touches. Develop on the branch the session names, squash-merge, and
record each measurement in `docs/research/m15.md` with its run id.
