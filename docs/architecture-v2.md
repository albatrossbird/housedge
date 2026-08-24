# Housedge architecture v2 — designing for N platforms, N outcomes, and search

Status: proposal / thinking document. Nothing here is built yet.

This is a from-scratch answer to: *what should this look like if the goal is a
Bloomberg terminal for prediction markets — all major venues, any category,
multi-outcome markets, full search?* It deliberately ignores how v1 is built,
then ends with a migration path that keeps what v1 got right.

---

## 1. The core problem: the current data model is two-platform, binary-shaped

Everything else follows from this.

```
markets(id, platform, title, yes_price, no_price, ...)
pairs(kalshi_id, polymarket_id, similarity)
```

Three hard limits:

1. **`pairs` names its platforms in its columns.** A third venue means either a
   second pair table per platform combination (N² tables) or a schema rewrite.
2. **`yes_price`/`no_price` are columns.** A 4-way market has no representation.
3. **Pairwise matching produces no canonical truth.** If A↔B and B↔C both match
   but A↔C doesn't, there is no single record saying "these are all the same
   market", and nothing detects the contradiction.

No amount of matching-quality work fixes any of these. This is the thing to
change first, because every additional platform, category, and stored row makes
it more expensive.

## 2. The model: canonical events → outcomes → listings → quotes

```
event         canonical, platform-agnostic
              "Fed funds rate upper bound, Sept 16 2026 FOMC decision"
                │
outcome        the mutually exclusive set for that event; probabilities sum to 1
              "above 3.00%" | "above 3.25%" | ... (or Team A / Team B / Draw)
                │
listing        one platform's tradable instrument for one outcome
              kalshi:KXFED-26SEP16-T3.00 (yes side) | polymarket:12345 ("Yes")
                │
quote          append-only time series: bid, ask, mid, volume, ts
```

What this buys:

- **Adding a platform is O(1), not O(N).** You write one adapter that maps that
  venue's instruments onto canonical events. You do not write a matcher against
  every existing platform.
- **Multi-outcome is native.** An event owns an outcome set; each platform lists
  whatever subset it offers. Binary is just the 2-outcome case, not a special one.
- **Arb generalizes to one rule.** For any mutually exclusive, exhaustive outcome
  set: if `Σ best_ask(outcome_i) < 1`, that's an arb. Binary `yes+no < 1` is the
  same formula. Cross-platform arb is that sum taken over the best ask *at any
  venue* per outcome.
- **Matching decisions become auditable records** on the listing→event edge
  (who decided, when, confidence, evidence) instead of an opaque similarity float.

### Identity is the resolution criteria, not the title

Two instruments are the same market iff **they pay out identically under the same
resolution source**. Not if they read similarly. This is the principle that the
v1 signature gate stumbled into empirically: "above 3.0%" ≠ "above 3.5%", US GDP
≠ UK GDP, rate *level* ≠ rate *hike count* — all differences in resolution
criteria that are nearly invisible to text similarity.

So the canonical event key is a structured claim, roughly:

```
subject           "US real GDP growth, quarterly, annualized"  (an entity ref)
metric_type       level | change | count | winner | ordinal | occurrence
comparator        gt | gte | lt | lte | range | eq
value(s)          3.0                     (+ unit: percent | bps | count | usd)
period            {quarter: 3, year: 2026}
resolution_source "BEA advance estimate"
```

Everything downstream — matching, dedup, search facets, synthetic combinations —
keys off this record.

## 3. The pipeline: normalize → block → adjudicate → cluster

This is standard entity resolution, and prediction markets are a textbook case
for it. Four stages, each with a different tool.

### 3.1 Normalize (the big unlock — and the biggest change from v1)

Every raw market from every venue → a structured claim record (above).

v1 does this with hand-written regex per category. That does not scale to
N platforms × M categories; every new venue's phrasing conventions mean new
parsers, and we already saw how many passes it took to get *one* category's
regex right ("Japanese" not matching `\bjapan\b`, bps vs percent, ECB with no
country name in the title).

**Use an LLM for structured extraction, cached by content hash.** Feed title +
rules/description + platform metadata, get back the typed claim as JSON.

Why this works economically: market titles are stable, so you pay once per
unique market, ever. At a few thousand markets across all venues this is
negligible, and it generalizes to a new platform or category with zero new code.
Failed/low-confidence extractions fall back to "unknown", which — per the v1
principle below — means *don't block on it*.

The regex work isn't wasted: **it defined the schema**. Unit, period, region,
comparator are exactly the fields that turned out to matter. They become the
extraction target.

### 3.2 Block (candidate generation)

Embed the *normalized subject*, not the raw title (raw titles are dominated by
boilerplate — "Will ... by ...?" — which is why wrong-threshold pairs scored
0.93). Store in **pgvector with an HNSW index**; retrieve top-K per listing.

This is also the scalability fix. v1 does an O(n×m) nested loop in JS inside a
serverless function, over vectors pulled across the network as JSON text. At a
few hundred markets that's fine; at 5k×5k across six venues it is not, and it
will hit function timeouts long before token costs matter. Nearest-neighbour
search belongs in the database as an indexed query.

Embeddings are a *blocker* here — narrow thousands to ~20 — not the decider.
That's the role they're actually good at.

### 3.3 Adjudicate (the decision)

Given a candidate pair of claim records:

- **Deterministic accept** when subject + comparator + value + unit + period +
  resolution source all agree. No model call.
- **Deterministic reject** on any hard conflict — different unit, different
  period, different region, different resolution source. (This is v1's gate,
  generalized and driven by extracted fields rather than regex.)
- **LLM adjudication only for the ambiguous middle**, with the verdict cached as
  a decided edge so it's paid once.

Keep v1's asymmetry rule, which proved correct: **reject only when both sides
have an extractable signature and they disagree.** Missing data must never
manufacture a rejection — otherwise coverage silently collapses as extraction
quality varies across venues.

### 3.4 Cluster into canonical events

Union-find over accepted edges → canonical event id. Detect and flag
contradictions (A↔B, B↔C accepted but A↔C rejected) rather than silently
picking one — a contradiction is a signal that extraction is wrong somewhere,
and it's exactly the kind of bug that is invisible without an explicit check.

### 3.5 Human review is a feature, not an admission of failure

For a terminal product, **a wrong match is far worse than a missing match** — it
displays a fake arb, someone acts on it, trust is gone. So:

- auto-accept above a high confidence bar,
- queue the middle band in a real review UI,
- every human decision is a permanent, first-class override with provenance.

Curated pairs are what the serious competitors actually ship. Plan for the
queue rather than treating manual review as temporary scaffolding.

## 4. Pricing: what a terminal has to get right

v1 stores a single `price` and overwrites it. Three things are missing, and all
three are load-bearing for credibility.

**Executable prices, not mid.** Arb is computed against what you can actually
transact at — you buy at the ask. Storing one blended "price" produces arbs
that evaporate on click. Store at minimum top-of-book bid and ask per listing;
depth if the venue exposes it (size matters — a 3¢ edge on $20 of liquidity is
not a trade).

**Fees, normalized.** Kalshi charges trading fees; Polymarket's economics
differ; gas/settlement costs differ again. Gross-price arb is not arb. The arb
condition is `Σ (ask_i + fee_i) < 1`. Until fees are modelled, every arb number
shown is optimistic by an unknown margin.

**History.** "Bloomberg terminal" means charts, spreads over time, historical
divergence. Quotes must be **append-only time series**, not an updated column.
Start recording immediately — this is the one thing that cannot be backfilled
later. Postgres with time-based partitioning (or Timescale) is entirely
sufficient; this does not need a specialist TSDB for a long while.

**Synthetic / combination markets — the real differentiator.** Kalshi's "GDP
above 3.0%" is exactly the union of Polymarket's "3.0–3.5" + "3.5–4.0" + "4.0+"
buckets. v1 treats that as an unmatchable case. It is in fact a *pricing
relationship*: `P(above 3.0) = Σ P(bucket_i)` for buckets above the threshold.
Once events carry structured outcome sets with comparators, these combinations
are derivable — and mispricings between a threshold contract and the equivalent
bucket set are precisely the inefficiencies a professional user is paying to
see. Nobody finds these by eyeballing two websites. Long-term, this is a better
moat than "we list the same market side by side."

## 5. Ingestion

Serverless request handlers are the wrong shape for this: they time out, cold
start, and cannot hold a socket. The forcing function is streaming.

- **Stream where offered** (Kalshi has a WebSocket; Polymarket has CLOB
  websockets), poll-and-diff where not.
- **Run ingestion as a long-lived worker**, separate from the web app — a small
  always-on process (Railway/Fly/Render) writing into Postgres. The web app
  keeps reading from Postgres and stays on Vercel.
- Per-venue adapters behind one interface: `fetchMarkets()`, `subscribe()`,
  `normalizeToListing()`. Adding a venue = one adapter + credentials, nothing
  else in the system changes.

Explicitly *not* recommended yet: Kafka, Flink, a separate stream processor.
Postgres plus a worker handles this scale comfortably, and premature
infrastructure is how solo projects stall.

## 6. Search

For "find any specific market", do **hybrid retrieval**:

- Postgres full-text (`tsvector`) for exact identifiers, tickers, team names
- pgvector for semantic/paraphrase queries
- fuse with reciprocal rank fusion
- facet on the structured claim fields (category, period, venue, event status,
  resolved/open, liquidity)

Vector-only search is bad at exact tokens like `KXFED`; keyword-only is bad at
"markets about the Fed cutting in the fall". The structured claim record is what
makes real faceting possible — that's a second payoff from stage 3.1.

## 7. Suggested sequencing

Ordered by (unblocks the most) × (gets more expensive to delay).

1. **Schema migration to event/outcome/listing/quote.** Everything else depends
   on it and it only gets harder. Can be done with the existing two venues and
   existing regex extraction — decouple the model change from the matching change.
2. **Append-only quote history.** Cheap now, impossible to reconstruct later.
3. **Bid/ask + fee modelling.** Required before any arb number is trustworthy.
4. **LLM structured extraction, cached.** Replaces per-category regex; unlocks
   new categories/venues without new parsers.
5. **pgvector + HNSW blocking.** Before market count makes the JS loop untenable.
6. **Third venue** (Manifold or PredictIt) — the real test that the abstraction
   holds. Do this *after* 1 and 4, and expect it to expose wrong assumptions.
7. **Review queue UI.**
8. **Hybrid search.**
9. **Synthetic/combination pricing.**

Sports fits this without a special case: the same normalize→block→adjudicate
path, where the claim's subject is the fixture (teams + date) and the outcome is
the side. That removes the hand-maintained per-league alias maps while keeping
the date/side verification that prevents sibling-swap bugs — which is exactly
the hybrid that was already planned for sports, just expressed in the general
model instead of as sport-specific code.

## 8. What v1 got right and should carry forward

- **Category scoping before matching.** Cross-category false positives were
  eliminated by construction, not by scoring.
- **Reject only on positive disagreement**, never on missing data.
- **Unit as a first-class distinction** (percent vs bps vs count). This caught
  rate-level-vs-hike-count matches that scored 0.87.
- **Globally greedy assignment** over score-sorted candidates, not per-row DB
  order — otherwise contested matches go to whoever was processed first.
- **Diagnostics in the response**: accepted pairs *and* rejected top candidates
  with scores. Nearly every bug this codebase had was invisible until the
  relevant counter or error string was surfaced. Keep this discipline in v2;
  it's the reason problems were found at all.
