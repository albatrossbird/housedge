# LLM extraction model bake-off — results

Run: 2026-08-21, via `/api/v2/extract-eval`. Total API spend: **~$0.92**.

## Result

| Model | Decision accuracy | $/1k markets | Time (128 mkts) | llmOnly | regexOnly | valueDisagree | avg conf |
|---|---|---|---|---|---|---|---|
| **Claude Haiku 4.5** | **16/16** | **$0.51** | **54s** | **51** | 0 | 0 | 0.893 |
| Claude Sonnet 5 | 16/16 | $2.88 | 156s | 48 | 0 | 1 | 0.762 |
| Claude Opus 5 | 16/16 | $3.30 | 110s | 50 | 0 | 0 | 0.866 |

`llmOnly` = markets where the LLM produced a usable claim and regex produced nothing.
`regexOnly` = regressions (regex saw something the LLM missed). Zero for all three.

## Decision: use Claude Haiku 4.5

It matches the larger models on every measured axis at **~1/6 the cost and half the latency**.

## What the numbers mean

**Coverage roughly doubled with zero regressions.** On a 100-market sample spread
across categories, regex extracted a claim for 48; the LLM added ~50 more and
missed none that regex caught. That gap is the whole argument for extraction —
it's markets the current gate simply cannot reason about.

**All three passed every labeled decision, including the four that each cost a
regex patch round**: `bps` units, ECB/BoE naming no country, "Japanese" not
matching `\bjapan\b`, and rate-level vs hike-count. The models handle these by
reading the claim rather than by accumulating patterns.

**The region difference between models is sports, not quality.** Opus populated
`region` on 100% of the sample vs ~50% for Haiku/Sonnet, which looked like an
edge. Inspecting raw output (`?raw=1`) showed the extra values are all Opus
labeling MLB player props `US` — true but useless for matching, since both
venues' MLB markets get the same value and it never discriminates. If anything
it's a mild negative: inconsistent region values across two sides of a pair can
only produce false *rejects*. On econ markets, where region actually decides
matches, **Haiku and Opus agree exactly** — US/US, CN/CN, EU/EU for the ECB
market, JP/JP for the Japanese bond yield.

## Honest limitation

**The decision set saturated.** All three scored 16/16, so this eval cannot
discriminate on accuracy — "same accuracy" here means "the eval could not tell
them apart," not "proven equivalent." The 16 cases were drawn from failures the
*regex* produced, which selects for problems an LLM finds easy.

Before trusting Haiku on materially harder input (a new venue with unfamiliar
phrasing, multi-leg or conditional markets, non-English titles), add cases that
actually separate the models and re-run. The harness takes a `models=` param
precisely so this is cheap to redo.

Sonnet 5's slightly worse showing (1 value disagreement, 4 unextracted vs
Haiku's 1, lowest confidence) is within noise at n=100 — not evidence it is
worse than Opus, just evidence it is not better than Haiku here.

## Cost projections at Haiku 4.5

| Workload | Cost |
|---|---|
| One-time backfill of all 1,283 distinct stored titles | **~$0.66** |
| Sports, ~12k new markets/month (if LLM-extracted) | ~$6/month |
| Sports via template parser, LLM only on parser miss | **~$0** |

Halve any of these with the Batch API — extraction is not latency-sensitive.

The parser-first split still holds and matters more than model choice: sports
titles are venue-generated from a handful of templates (high volume, near-zero
novelty), so a deterministic parser should handle them and the LLM should be the
fallback. That keeps recurring spend proportional to novelty rather than volume.

## Reproducing

```
/api/v2/extract-eval?pairsonly=1&models=claude-haiku-4-5   # decisions only, ~2c
/api/v2/extract-eval?limit=100&models=claude-haiku-4-5     # + coverage
/api/v2/extract-eval?limit=16&raw=1&models=...             # inspect claim values
```

Run one model per request — three models x 100 markets exceeds the Vercel
function timeout.

---

# Wiring extraction into the pipeline — result

Run: 2026-08-21. Econ fully extracted (327 distinct titles, 654 listings,
claude-haiku-4-5, **$0.165**).

## Headline: extraction did NOT find more econ pairs

| Gate | Econ pairs |
|---|---|
| Regex signature gate | 1 |
| LLM claim gate | 1 |
| Disagreements between them | **0** |

Both gates independently accept exactly one pair — Kalshi "real GDP more
than 3.0% in Q3 2026" ↔ Polymarket "US GDP growth in Q3 2026 greater than
3.0%" — out of 3,745 candidate pairs above the 0.78 similarity threshold.

**This is a real negative result, not a setup problem.** It confirms via
an independent method what the uncapped `topScores` audit suggested:
Polymarket does not list most of Kalshi's econ thresholds, so there is
nothing to match them to. Kalshi publishes ~9 GDP threshold buckets per
quarter plus a Fed rate ladder per meeting; Polymarket lists one GDP
question per period and expresses Fed policy as hike *counts*. One pair
is the genuine overlap.

Two independent gates agreeing is considerably stronger evidence for that
conclusion than one gate asserting it.

## What the run did surface: a bug in the claim gate

The first rematch reported 2 pairs vs regex's 1, which looked like the
hoped-for improvement. The extra pair was wrong:

```
Kalshi:     GDP more than 2.5% in Q4 2026     (quarterly)
Polymarket: US GDP growth in 2026  > 2.5%     (annual)
```

Quarterly growth and annual growth are different measures. Regex rejected
it correctly; the claim gate accepted it.

The fault was in `claimsCompatible`, not in extraction — the model
extracted `quarter: 4` and `quarter: null` correctly. The gate only
blocked when *both* sides had a quarter, applying the
block-only-on-mutual-disagreement rule that is right for genuinely
missing data. But a null quarter beside a populated one is not missing
data: it means "annual", which is a different claim. The regex
`periodsCompatible()` had always encoded this ("if either has a quarter,
they must match"); porting it loosely is what introduced the bug.

Fixed, re-verified against the 16 labeled cases (still 16/16), and the
disagreement count fell to 0.

**The lesson generalizes:** "don't block on missing data" is correct for
fields where absence means *unknown*, and wrong for fields where absence
means *a specific different value*. Period granularity is the second
kind. Worth checking any future gate field against that distinction.

## Not yet done: the write path

`/api/v2/rematch?write=1` is implemented but was deliberately not run.
It keys events on `source_key = claim:{listing_id}`, while backfilled
events use `v1pair:{kalshi_id}` — so writing now would create a second
event for the same market rather than updating the existing one. Before
using it, events need deduplication on something canonical
(subject + period + region), which is the natural next step and is also
what the schema was designed to support.

## Where extraction does earn its cost

Not here, on two mature venues in a category whose overlap is genuinely
one market. The value shows up where the bake-off measured it: **coverage
roughly doubled** (a usable claim on ~50 of 100 markets where regex
returns nothing), which is what determines whether a *new* venue or
category works on day one instead of after four rounds of regex patching.
Econ was the hardest case for regex and the least rewarding for
extraction, precisely because we already hand-tuned regex against it.
