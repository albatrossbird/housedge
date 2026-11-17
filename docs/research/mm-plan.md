# Market making where Kalshi pays for it: a free study. Plan, fixed before any read

Written 2026-11-16. A candidate from `brief.md`, at the user's request.
Nothing here places an order or needs a key: every read is a public
Kalshi endpoint. No box, no recorder, no Actions minutes.

## Question

Could a small account earn more from Kalshi's Liquidity Incentive
Program, plus the spread, than it loses to being filled at the wrong
moment?

Nothing we run today is market making. The resting-order test on p75
(m15.md, 2026-11-16) showed the risk in its plainest form: every order
the resting bid missed went on to win. The reward pool has to outweigh
that.

## How Kalshi scores it (help page, read 2026-11-16)

- A **snapshot** is taken once a second, at a random moment.
- A snapshot counts only if resting orders reach the market's **Target
  Size** on BOTH the yes and the no side.
- The **Reference Price** on a side is the first level, walking down
  from the best bid, where cumulative size reaches a fifth of Target
  Size. An order at or better than it scores its full size; an order
  further away scores `size x DiscountFactor ^ ticks away`.
- A side's score is shared pro rata. **Our share of a side = our score
  / everyone's score on that side.** A snapshot is worth at most 2.0
  (1.0 a side).
- Reward for a period = our share of all snapshot scores x the period's
  pool x the fraction of snapshots that counted. Paid daily, $1 minimum
  per market program.
- Not stated on the page: a minimum order size, a cap per account, a
  minimum resting time. The formal terms page refused the read (HTTP
  429) and still has to be read.
- Kalshi can change or end any program at any time.

On 2026-11-16 `/incentive_programs` listed 6,122 active programs over
394 series: a median of about $14 a day per market, a median Target Size
of 1,000, none on a crypto price series.

## Part A: what share would a small quote score? (one sweep, about 25 minutes)

For every active program market, one read of `/markets/<t>/orderbook`:
- the resting size on each side at or better than the Reference Price,
  and the discounted size behind it (the program's own Discount Factor
  and Target Size, from `/incentive_programs`);
- whether the snapshot would count (Target Size reached on both sides);
- **our share if we rested S contracts on each side at the Reference
  Price**, for S worth about $200 of capital (S = 200 / (bid + 1 - ask),
  both orders together), and the reward that implies:
  `pool per day x (yes share + no share) / 2`.

Swept three times at different hours before it is believed, since a
book at one moment is one moment.

**Stop after Part A** if both hold: the median market pays our $200
under $0.50 a day, AND fewer than 50 markets pay it $2 a day or more.
Then the pools are too crowded for a small account and the study ends.

## Part B: what do the fills cost? (the tape, only if A passes)

Two fixed samples from Part A's first sweep, chosen before any tape is
read: the 300 markets with the highest reward per dollar, and 300 drawn
at random from the rest (the control: are the rich pools rich because
they are dangerous?).

For each, the last 14 days of `/markets/trades` and one-minute candles.
A quote of S a side rests at the candle's bid and ask and is re-posted
each minute. Fills, bracketed two ways because no queue is published:
- **front:** every taker trade at our price fills us, up to S;
- **back:** we fill only when the price trades THROUGH our level.

Each fill is marked to the mid 1, 10 and 60 minutes later, and to
settlement where the market has settled. Per market and day: spread
earned, loss to adverse moves, inventory left at the end.

## The bar

Worth a written plan for a paper trial only if, on the 300 richest
markets and under the **back** bound for fills:
- reward plus spread minus adverse loss is positive on at least half of
  them; and
- the best 25 together clear **$10 a day on $5,000** of capital (the
  build bar used elsewhere in this research), in both weeks.

**Otherwise stop.** A pass is a candidate for a paper trial, never a
profit claim: the replay cannot see how others would react to our
quotes, and Kalshi can end a pool the day we arrive.

## What it would take if it passed (for the user, not decided here)

Capital for inventory, an account eligible for the program (regular
U.S. members are; FCM customers are not), and an order budget large
enough to re-quote: ask the trader for `GET /account/limits`. Speed and
language are not the constraint.

## Note, 2026-11-17 (after a 25-market trial of the script, before the first sweep)

The trial showed something the plan missed. In 15 of the 25 markets one
side held under a fifth of the target, so there was no reference price
to join and the plan's quote scored nothing. But a small account can
SUPPLY that side: post enough at its best bid to bring it to Target
Size. Bids on a thin side are often a few cents, so 1,000 contracts can
cost $20-40, and whoever supplies a side scores most of it.

So Part A scores two quotes on every market, with the same $200:
- **join:** the plan's quote, both sides at the reference price;
- **supply:** each side first brought up to the target (at its best
  bid, or a tick under the other side's implied ask where it is empty),
  the rest of the money split evenly.

**Part A stops only if BOTH fail the bar.** Part B's "300 richest"
are taken from whichever quote pays more on each market.

What supply cannot show, and Part B must: a bid resting alone on a thin
side is the first thing hit when the market moves that way. A cheap side
is cheap because the outcome is unlikely; being filled on it means
holding the long shot.

## Part A, sweep 1 (2026-11-17 04:08 UTC, 11pm New York): CONTINUE

5,853 active programs on 5,853 markets in 403 series, every book read
(5,864 requests, 22 minutes). Pools add to about $110,000 a day; the
median market's is $14.29 a day, Target Size 1,000, Discount Factor 0.5.

| quote ($200 a market) | snapshot counts on | median paid a day | markets paying $2+ | markets paying $0.50+ |
|---|---|---|---|---|
| join | 5,091 | $0.62 | 1,405 | 3,168 |
| supply | 5,335 | $0.76 | 1,650 | 3,412 |

The stop needed a median under $0.50 AND fewer than 50 markets at $2+.
Neither quote is near it. The best 25 markets would pay the join quote
$691 a day on $4,991 **before any loss on fills, and before anyone
reacts to our orders**. That is the size of the reward, not a profit:
a figure this large against so little capital says the fills are where
the money goes, which is Part B's question. Richest series for our
quotes: KXART, KXRT, KXYTVIEWSW, KXVOICERANK, weekly shipping-count
markets. These are markets that jump on one piece of news.

**The help page re-read the same day** (the formal terms at
kalshi.com/regulatory/notices refused again, HTTP 429):
- Target Size is "the depth that must be resting on each side for a
  snapshot to count": plain resting size. The script's second, stricter
  reading (score near the price) is dropped from here on.
- "If a side of the book never reaches the Target Size, no orders on
  that side qualify for that snapshot."
- A snapshot taken while the market is not open is excluded, and the
  reward is scaled by the share of snapshots not excluded. So a market
  that closes early in its period pays only for the time it was open
  and two-sided: `pool per day` here is the period's reward over the
  period's days, an upper bound for a market about to close.
- A market's daily reward is between $1 and $1,000; a final reward
  under $1 on one program is not paid and does not combine with others.
- Not eligible: FCMs, introducing brokers and their customers, and
  non-U.S. users. No cap per account, minimum order size or minimum
  resting time is stated.

**One thing the supply quote shows that needs the formal terms before
it is believed.** Its two best rows are markets priced at 98-99c with
an empty other side, where 1,000 contracts at 1c ($10) would be the
whole side. If that paid half a $100-a-day pool, somebody would already
be doing it. Either the terms rule it out, or those orders are hit the
moment the market turns. Supply rows on a side priced under 5c are
reported apart in Part B and never counted towards the bar.

Sweeps 2 and 3 follow at other hours (about 13:30 and 21:00 UTC).
Part B's two samples are taken from THIS sweep's saved file, as the
plan says: the 300 best by reward per dollar (the better of the two
quotes on each market) and 300 from the rest, drawn by a hash of the
ticker so the draw can be repeated. The file is not in the repository
(downloaded Kalshi data stays out); if the sandbox loses it, the
samples are re-drawn the same way from the next sweep and that is said.

## Part B: details fixed 2026-11-17, before any tape is read

The plan above left these open. They are fixed here, and only ever make
the test harder.

**A third sample, because the first two cannot see the end of a
market.** Both samples are markets still open at sweep 1, replayed over
the 14 days before it. A market that jumps on one piece of news does
most of its damage to a resting quote at the END of its life, and an
open market has not got there yet. Kalshi lists past programs
(`/incentive_programs?status=paid_out`), so:
- **ended:** 300 markets drawn by a hash of the ticker from programs
  that ended in the 14 days before sweep 1 and whose market has since
  settled. Each is replayed from its program's start (at most 14 days)
  to the market's close and its inventory is marked to SETTLEMENT.
  There is no past book to score a share from, so its share is the
  median sweep-1 share in the same series (the overall median where the
  series is not in the sweep). That is an assumption and is said beside
  every figure that uses it.
- **A pass on the bar that the ended sample contradicts is not a
  pass.** If the ended sample's reward plus fills is negative in total
  under the back bound, Part B fails whatever the richest 300 say.

**The quote.** On each market the better-paying of sweep 1's two quotes,
with its sizes. Each minute it rests at the last candle's closing bid
and ask (carried forward through minutes with no candle); a supply
quote on an empty side rests one tick inside the other side's implied
price. **Position cap:** the net position never exceeds the quote's
size on either side; a side that is full posts nothing until the other
side trades it down. Without a cap, $200 of capital is fiction.

**Fills.** A taker trade against our side at our price or worse for the
taker's counterparty fills us AT OUR PRICE, up to what is posted:
front = at or through our price; back = strictly through it. Maker fees
by the series' `fee_type` (`kalshiMakerFee`); a series whose schedule we
cannot read is dropped and counted.

**P&L of the fills** = cash paid and received, plus inventory at the
end: at settlement where settled, else long YES at the last bid and
long NO at one minus the last ask (never the mid). Marks to the mid 1,
10 and 60 minutes after each fill are printed as a diagnosis and do not
enter the bar.

**Reward** = the pools Kalshi actually listed for that market over the
replayed minutes (active, closed and paid-out programs) x the sweep-1
share of each side / 2, for each minute that side is posted with the
market two-sided, in proportion to the size posted. An upper bound: it
assumes the snapshot always counted and that nobody answered our quote.

**The best 25 are chosen BEFORE the replay:** the 25 highest by sweep-1
reward per dollar among the richest 300, leaving out any supply quote
whose supplied side is priced under 5c. Shown beside it, not as the
bar: the 25 best on week 1's net, scored on week 2.

**Weeks:** week 1 is days 14 to 8 before sweep 1, week 2 days 7 to 1.
A market with under 3 days of history in a week is left out of that
week's count and the number left out is printed.

**Two more details, fixed 2026-11-17 before any tape is read** (found
while writing the replay):
- **The quote rests only in minutes when a program is paying for that
  market.** Nobody would quote a one-news-event market for nothing, and
  most current programs started days ago, so quoting all 14 days would
  charge the replay with fills nobody would take. Inventory bought
  while paid is still held, and marked at the end or at settlement.
  "Under 3 days in a week" counts quoted minutes.
- **The ended sample's quote** is the join quote: S = $200 / (bid + 1 -
  ask) a side at the first two-sided candle of its window, resting at
  the candle's bid and ask. Window: the later of its programs' start
  and 14 days before close, to close (at most 14 days, as above). Its share is the median sweep-1
  JOIN share per side in its series (over markets where a join quote
  existed), else the overall median.
- Markets whose quote does not exist in sweep 1 (cost $0) are not in
  the random draw; a quote that cannot be posted cannot be replayed.
- A market whose trade tape runs past 200 pages (200,000 trades) in its
  window is dropped and counted rather than replayed on part of it.

**Trial of the script, 2026-11-17** (4 markets a sample, to check the
plumbing; not read against the bar): it runs end to end. One structural
fact it showed, recorded before the full run so it cannot be used as an
excuse after: many of the richest markets are WEEKLY (Panama and
Hormuz transit counts, for example), born a few days into week 1, so the
best 25 may have few markets with 3 quoted days in week 1. The bar is
left as fixed; the count left out is printed beside it.
