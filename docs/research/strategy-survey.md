# How people make money on Kalshi: a survey, checked against what we measured

Written 2026-11-18 at the user's request. Online reading only; nothing
here was run. Sources are academic papers, Kalshi's own pages and the
CFTC. The many strategy blogs and bot sellers read along the way are
not named (standing rule), and their claims are treated as opinion:
almost none show a backtest, and several conflict.

## What the measured evidence says about who wins

**Kalshi, 2021 to April 2025** (Bürgi, Deng and Whelan, "Makers and
Takers", 313,972 contracts across 46,282 markets, read in full):
- Contracts at 10c or less lose **over 60%** after fees. Above 50c
  returns are small and positive; above 70c, statistically significant.
- **Makers average -9.64%, takers -31.46%.** Makers buying at 50c or
  more earn **+2.6%**. Cheap contracts are mostly bought by takers.
- The bias holds in every category (financials, weather, crypto,
  economics; weaker in politics and entertainment) and every year,
  smaller in 2025.
- Losses on cheap contracts are largest on the **final day**, for
  makers as well as takers.

**Kalshi sports, March to May 2026** (Moshrefi, arXiv 2607.14430, 23M
NBA/MLB/NHL moneyline trades):
- Mid-game (30-240 minutes before close) prices are well calibrated.
- **In the final 10 minutes the calibration becomes step-like:**
  favourites win more than their price says and underdogs less. On NHL,
  "contracts trading at 10-40 cents in the final ten minutes resolve
  favorably almost never".
- **Cross-game parlays are overpriced** relative to their legs by about
  3% a leg (median ratio 0.99 at 2 legs, 1.04 at 7, 1.22 at 10).
  Combos are priced by institutional market makers over RFQ: the money
  is on the quoting side.
- Measured against the time the market actually closed, which a trader
  does not know in advance (see "the test" below).

**Polymarket on-chain studies** (one week of 15-minute crypto markets,
46,945 wallets; and a year of arbitrage, arXiv 2508.03474):
- 36.8% of 15-minute crypto wallets were up for the week, pre-fee.
  Makers netted +$728k, takers the same amount negative. Takers won
  more individual trades but lost money.
- About $40M of arbitrage was taken in a year, mostly within a single
  market (outcomes priced to sum away from $1), concentrated in a few
  fast wallets, "largely during lower liquidity moments".
- Profitable wallets are a small minority (0.5% made over $1,000 in the
  largest sample) and run small, repeatable edges.

## The strategies, ranked by what it would take us

| strategy | evidence it works | our own measurement | for us |
|---|---|---|---|
| **Buy late favourites** (expensive contracts near the end) | strong: Kalshi-wide and sports-specific papers | p75 is this on BTC 15-minute markets; live since 11-17 | **extend it to sports: test 1** |
| **Weather with live observations** (outcome already visible in station data before the market closes) | settlement source is public (NWS climate report; Kalshi rules); edge claims unverified | none | **test 2** |
| **Within-market sum gaps** (mutually exclusive brackets priced away from $1) | $29M on Polymarket in a year, largest in thin moments | the BTC ladder: real, gone in 5ms | **a one-sweep check on slow markets: test 3** |
| Cross-venue and sportsbook value | widely practised; edges small and short | MarketSlap's board: median arb ~0.5% | already the site's product |
| Market making for rewards or spread | makers out-earn takers on average | our study FAILED: endings run the quote over | stopped |
| Resting orders on favourites | makers at 50c+ earn +2.6% | p75 maker test FAILED: the misses all won | stopped |
| Speed (latency arbitrage) | over 70% of crypto arb profit to sub-100ms bots | ladder STOP; sharp-move gains nothing below 100ms | not for us |
| Selling parlays (combos) | overpriced ~3% a leg | needs RFQ market-maker access and capital | not for us |
| Economic data vs nowcasts | Kalshi tracks or beats consensus; no measured edge | none | low priority |
| Mention markets (transcript base rates) | vendor claims only; CFTC pulled many in Nov 2026 | none | skip |
| Information edge (knowing the outcome) | illegal: CFTC calls it a top-five priority, first case April 2026 | n/a | never |

## The three tests worth running (free, public data)

**Test 1: late favourites in sports.** p75's idea on Kalshi game
markets (NBA, NHL, NFL, college football, MLB): buy the side priced
75-97c late in the game, held to settlement. The papers measure "late"
against the market's actual close, which a trader cannot see coming, so
a fair test needs the **game clock**. ESPN's public play-by-play stamps
every play with wall-clock time (checked: the last play of POR at MIN on
11-17 at 03:36:56 UTC, Kalshi's close at 03:37:40), so the decision can
be taken on "N minutes left on the game clock" and priced on Kalshi's
trade tape. Sports games charge makers and takers a fee
(`quadratic_with_maker_fees`, multiplier 0.5 on MLB); small at 90c.

**Test 2: weather settled by what has already happened.** Daily-high
markets settle on the NWS Daily Climate Report. Late in the day the
high is usually set, and hourly station observations (public) show it.
The question: are outcomes the observations already confirm still
priced below about 97c? Traps the settlement rules name: whole-degree
values, local STANDARD time during daylight saving, and the report
being checked against the 6- and 24-hour highs.

**Test 3: bracket sums on slow markets.** One sweep of every mutually
exclusive Kalshi event (weather brackets, economic ranges): do the YES
asks across an event's brackets ever sum under $1 after fees, or the
NO asks under (n-1)? The BTC ladder showed these vanish in milliseconds
where bots watch; slower markets may not be watched as closely.

Each gets its own plan, fixed before any data is read, like the others.
