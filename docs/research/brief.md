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

**Waiting on the user**
- **Restart decision** (`restart-plan.md`). Proposal: sharp-move at 10
  contracts, no filter, $100 drawdown stop; p75 at 10 contracts with two
  time filters (no order 16:00-19:59 New York time, none on Saturday or
  Sunday), $75 stop; both reviewed at 300 settled (stop if t <= -1). No
  rule linking the two. The paste-ready trader block is in the session;
  the trader first splits its 302 live p75 fills by the two filters.
- **From the trader:** sharp-move's live totals since it started, and
  `GET /account/limits`.

**Running**
- **Ladder step 2** (`ladder-step2-plan.md`). The recorder
  (`marketslap-ladder-stream`) has run on the box since 2026-11-15
  05:49 UTC, healthy. **Early stop on 11-18** (a follow-up is scheduled
  for 00:30 UTC: `laddergaps` over 11-15..11-18); build bar on 11-29.
  The first day alone, a pipeline test, showed 52 qualifying gaps with a
  median life of 6ms and no two-legged fill from +25ms: it points to
  STOP. If it stops, the user turns the recorder off on the box.
- **p75's filters, scored on the tape** from the restart day for 8
  weeks, if p75 restarts.

**The bar for a skip rule** (the user's, 2026-11-16): t <= -1 against
the rest, the skipped trades losing money themselves, and worse in both
halves. Adding size or trades stays at t 2. See `restart-plan.md`.

**Done**
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

**Candidates, not started**
- **Market making where Kalshi pays for it:** the study plan is written
  (`mm-plan.md`, 2026-11-16). Part A (one sweep of every program
  market's public order book: what share would $200 a market score?)
  runs from the research sandbox once the four-month sharp-move run has
  finished; Part B (fills against the tape) only if A passes.
- **p75's 75-85c band:** its November re-test is spoiled through 11-14
  (it was printed). Fair test: days after 11-14.
- **The BTC 2-minute underdog at 3-20c:** November re-test, to be fixed
  before scoring.

## How to start

Read this file, then the sections of `docs/research/m15.md` a task
touches. Develop on the branch the session names, squash-merge, and
record each measurement in `docs/research/m15.md` with its run id.
