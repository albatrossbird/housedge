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

## Live state (2026-11-13)

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

## Open tasks, in order

1. **Ladder consistency (first task). In progress:** plan and bars fixed
   in `docs/research/ladder-plan.md`; size pass done 2026-11-14 (early
   stop not triggered); the tape read is next. The question: do Kalshi's hourly
   and daily crypto strike ladders ever trade at prices that contradict
   each other by more than the fees? Two examples of a contradiction:
   - "above a higher strike" priced over "above a lower one";
   - outcome sets that should sum to 100% summing to less after fees.

   Start from the public trade tape and one-minute candles (no box, no
   new recorder). Find the series from `/series?category=Crypto`; do not
   assume names. Write the stop rule before the run. Suggested: stop if
   two weeks of tape show under about $10 a day of after-fee edge at
   sizes the book actually traded. Only if it passes, record a few days
   of those books to measure how long the gaps last. If they last under
   ~50ms, only a co-located bot gets them, and we stop.
2. **What speed is worth.** Add +0, +25 and +50ms rows to section D of
   `scripts/m15-index.mjs`, which has +100ms and +250ms today. If going
   below ~50ms adds little to sharp-move, no speed project pays (Rust,
   FIX, co-location, a faster BRTI feed).
3. **November re-tests, each fixed before scoring:**
   - p75's 75-85c band;
   - the BTC 2-minute underdog at 3-20c;
   - p75 weekday against weekend, scored on days after 11-10 only.
4. **Resting orders on November.** Re-run the maker backtest
   (`source: archive`, `maker`). Makers pay no fee on the 15-minute
   series; read "won when filled" against "won when missed".

## How to start

Read this file, then the sections of `docs/research/m15.md` a task
touches. Develop on the branch the session names, squash-merge, and
record each measurement in `docs/research/m15.md` with its run id.
