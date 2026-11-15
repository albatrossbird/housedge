# What speed is worth: plan, fixed before the run

Written 2026-11-15, before the run. Open task 2 in `brief.md`. Nothing
below changes after the first scored number except by a dated note.

## Question

Would a faster bot pay? That covers a Rust rewrite, FIX, co-location
and a faster BRTI feed. Speed decides only which sharp-move decisions
fill, and at what price; it never changes the decision itself.

## Method

`scripts/m15-index.mjs` section D fills each 1bp sharp-move decision
against the recorded book at a delay after the deciding tick's CF
stamp. It had +100ms and +250ms; it now also has **+0, +25 and +50ms**.
New section **D5** pairs each delay against +100ms on the same
decisions:
- limit seen +1c, 40 contracts;
- the difference in dollars, per recorded day, and per contract asked;
- t on the daily difference, and the two halves.

For scale: the live bot runs at a median of ~82ms from the deciding
stamp to Kalshi.

**Days:** 2026-10-22 to 2026-11-15, everything after the in-sample
period (workflow `source: index`, `days: 2026-10-22..2026-11-15`, size
40).

+0ms is the physical limit, the book at the instant of the tick. Not
even a co-located bot gets there.

## Bars

1. **A code-speed project** (a Rust bot or FIX, not co-located; realistic
   target +50ms) pays only if:
   - +50ms beats +100ms by at least **$10 a day** at 40 contracts, with
     **t >= 2** on the daily difference and both halves positive; and
   - sharp-move itself is **positive at +50ms with t >= 2**.
2. **Co-location** (realistic target +0 to +25ms) is only reported. It
   is recommended only if +25ms beats +100ms by about **$100 a day** or
   more, sustained, with the same conditions on the rule itself
   (`ladder-plan.md`, note of 2026-11-14). Even then it is the user's
   spending decision.
3. **Otherwise no speed project pays** for sharp-move, and that is
   recorded in m15.md with the run id.

Speed cannot rescue a rule with no edge: a faster bot on a losing rule
loses faster. Both bars need the rule itself positive at that delay.

## What it does not cover

The ladder contradictions (`ladder-step2-plan.md`) are a different
trade, where speed is the whole question. That is answered by recorded
ladder books, not by this run.
