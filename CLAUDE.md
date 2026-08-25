# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Housedge is a prediction-market odds comparison dashboard: it pulls live markets from Kalshi and Polymarket, matches equivalent markets across the two platforms, and displays side-by-side odds with arbitrage alerts.

- **Live site**: https://housedge.vercel.app
- **Supabase project**: smoewpcbpjfcqpyswyli.supabase.co
- Deployment is automatic on every push to `main` (Vercel). There is no separate staging environment.

## Commands

- `npm run dev` — start dev server at http://localhost:3000
- `npm run build` — production build (also the only real "test" — no lint/test scripts configured)
- `npm start` — run production build
- `node explore.js` — standalone debug script for paginating/inspecting the Polymarket API directly (not part of the app).

## Environment variables

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — required, all data flows through Supabase. Set in Vercel dashboard for prod, `.env.local` for local dev.
- `VOYAGE_API_KEY` — required for `/api/embed` on non-sports categories (Voyage AI embeddings, free tier).
- `KALSHI_API_KEY` — present in `.env.local` but currently unused; Kalshi market data is public and needs no auth.

## Architecture: three-stage pipeline through Supabase

The frontend never calls Kalshi/Polymarket directly. Data flows through three API routes that run at different cadences:

1. **`pages/api/embed.js`** — the expensive, infrequent job. Fetches raw markets from both platforms, upserts them into `markets`, and computes cross-platform matches into `pairs`. Two matching strategies:
   - **Sports (mlb/nba/nhl/soccer)**: structured matching — extracts both team names per title (via `MLB_TEAMS`-style alias maps + regex on Kalshi's "Team A vs Team B" / Polymarket's "Will Team A win" formats), requires both teams to match, gates on game date within 6 hours. No embeddings.
   - **Economics/crypto/politics**: `matchNonSportsMarkets()` — Voyage AI (`voyage-4-large`) embeddings + cosine similarity above `?threshold=` (default 0.78), **then** a hard signature gate (see "Scalar-market matching" below).
   - Query params: `?sport=mlb|nba|nhl|soccer|econ|...`, `?matchonly=1` (re-match stored markets without re-fetching or re-embedding), `?force=1` (re-embed/re-match everything), `?threshold=`.
   - Not called by the page — triggered manually or by a scheduled job (no cron exists yet).

2. **`pages/api/refresh.js`** — the cheap, frequent job. Updates price/volume for markets already in `markets` without rediscovering or rematching. Runs every ~15 minutes from GitHub Actions (see "Automation"). Scoped to markets that appear in `pairs`; last verified run refreshed 46 Kalshi series / 241 rows in 40s.

3. **`pages/api/markets.js`** — what the frontend polls (every 60s). Calls the `get_pairs(sport_tags)` Postgres RPC, which joins `markets` and `pairs` in SQL (chained Supabase JS-client filters were silently failing, hence the raw RPC). Filters stale/expired-date rows and prices outside 0.05–0.95, then shapes for the UI.

`pages/index.js` is a single-file client (category tabs, sort controls, market cards, arb badges) with inline styles — no CSS framework. Arb logic: `min(kalshi.yes, poly.yes) + min(kalshi.no, poly.no) < 0.97` AND spread ≤ 15 points (larger spreads are treated as data errors, not real arbitrage — see the Polymarket outcome-price bug).

### Automation

Both jobs run from GitHub Actions, not Vercel cron: the Hobby plan caps
crons at once per *day*, which is not a fix for stale prices. The repo is
public, so Actions minutes are free and unmetered.

- `.github/workflows/refresh-prices.yml` — `/api/refresh`, ~every 15 min.
- `.github/workflows/discover-markets.yml` — `/api/embed` per category,
  daily, sequential with a pause. Categories: `mlb nba nhl soccer econ
  crypto politics`.

Both fail the run loudly on non-JSON, an `error` field, or zero rows
updated. The original stale-price bug survived for weeks precisely
because a silent no-op looked like success.

`lib/cronAuth.js` gates both endpoints behind an optional `CRON_SECRET`
(permissive until the var is set on Vercel *and* as a repo secret).

### Hitting the routes by hand

```
/api/refresh                      # prices only, cheap, safe to hit often
/api/embed?sport=econ             # fetch + store + embed + match one category
/api/embed?matchonly=1&sport=econ # re-match only (no fetch, no re-embed) — use for threshold/gate iteration
/api/embed?matchonly=1&sport=econ&dry=1  # same, but writes nothing
/api/embed?force=1&sport=econ     # re-embed everything (needed after an embedding-model change)
```

**Use `dry=1` whenever you are trying a threshold out.** `matchonly`
deletes and rewrites the category's pairs by default, so "just looking"
at a lower threshold publishes whatever it produces — that is how 71
wrong crypto pairs once reached production.

`/api/refresh` scopes itself to markets that appear in `pairs`: it derives
the Kalshi series to poll from the paired tickers (`<SERIES>-<event>-<outcome>`)
and fetches only the paired Polymarket ids. Those are the only markets
the site renders; unpaired rows get their prices from the daily discovery
run. A hand-maintained `KALSHI_SERIES` constant is what left every crypto
and politics series unrefreshed.

## Scalar-market matching (the core non-sports problem)

Embedding similarity alone **does not work** for threshold markets, and this is not fixable by tuning the threshold. Kalshi models GDP/CPI/Fed-rate as a family of ~9 near-identical binary questions per period ("above 0.5%", "above 1.0%", … "above 4.0%"); their titles share ~95% of their text, so wrong-threshold pairs score *higher* (0.88–0.93) than any cutoff that would still admit real matches. An audit of 43 embedding-only pairs found nearly all wrong.

The fix is embeddings for candidate generation + a **hard signature gate** before acceptance, in `embed.js`:

- `extractNumericClaim(title)` → `{unit, op, value|low/high}`. Units are `percent`, `count` ("5 or more rate hikes"), `bps` ("25 bps increase"). A **unit mismatch is always incompatible** — a rate-*level* question is not a rate-*hike-count* question even though they're correlated.
- `extractPeriod(title)` → `{quarter, year}`.
- `mentionsNonUsRegion(title)` — Kalshi's econ series (KXFED/KXCPI/KXGDP/KXRECESSION) are implicitly US-only and never say "US", while Polymarket covers many countries with identical phrasing and thresholds. Blocks country names **and their adjective forms** (`\bjapan\b` does not match "Japanese") **and** foreign central banks (ECB, BOE, BOJ, …), which name no country at all. Scoped to `sportTag === "econ"` since it's a fact about that Kalshi series, not a general rule.
- `extractUsdStrike(title)` → `{unit: "usd", op, value}`. Crypto is the same bucket problem with `$` where econ has `%`: "XRP above $6.50" vs "XRP reach $6.00" scored 0.917. Handles `$100k`/`$129,999.99` notation, normalises Kalshi's cent-below convention (`above $99,999.99` **is** the $100,000 market), and reads direction from both vocabularies — `above/reach/hit` vs `below/dip to/drop to` — because "XRP above $2.00" and "XRP dip to $2.00" are the same strike and opposite bets at 0.919. Strikes compare **exactly, in cents**: `NUMERIC_EPS` is an absolute margin sized for percentages and called `$0.02` and `$0.06` the same market. `"hit $50,000 before $100,000"` is a race between two strikes, not a threshold, and gets its own unit so nothing can pair with it.
- `extractDeadline(title)` / `deadlinesCompatible(a, b)` — the numeric gate is inert on politics and crypto titles that carry no number at all, so deadlines are what separate "Tempo launch a token **before Jan 1, 2027**" from "**by December 31, 2027**" (0.962, a full year apart). Tolerance is 3 days, small but non-zero: "before Jan 1, 2027", "before 2027" and "end of 2026" name the same boundary while parsing a day apart. `by <year>` reads as the *start* of that year (Kalshi's own `side_label` confirms it — "by 2027" is labelled "Before 2027"); `in <year>` reads as the whole year.
- `hasUnresolvedDeadline(title)` — Polymarket routinely drops the year ("by June 30?"). A stated cutoff we can see but cannot resolve is **not** a missing signature, so it is rejected against a side that does state its year. Two vague titles still fall through.
- `scalarSignaturesCompatible(a, b, sportTag)` combines them. **Reject only when both sides have an extractable signature and it disagrees** — anything unrecognized falls through to embedding score alone, so the extractors don't need to understand every phrasing to be useful. The deadline rules above are the deliberate exception: absence of a *resolvable* year, where a year is clearly being stated, is itself information.

Matching is **globally greedy**: build all gate-passing `(kalshi, poly, score)` candidates, sort by score descending, then assign. Assigning per-Kalshi-row in DB order (the old way) meant whichever row was processed first claimed a contested Polymarket market, not the best-scoring one.

`matchNonSportsMarkets()` is shared by both `matchonly` and normal mode. They were separately duplicated for a while and drifted (a diagnostic added to one branch, missing in the other) — keep them unified.

### Diagnostics convention

Both modes return `matchDiagnostics` with `threshold`, embedded counts, `acceptedPairs` (what was actually paired, post-gate, post-exclusivity), and `topScores` (best candidate per Kalshi row **regardless of threshold or gate**). `topScores` is what distinguishes "real candidates just under threshold" from "nothing close" from "gate correctly rejecting". Write routes return per-stage `writes` counts and real error strings. **Keep this** — nearly every bug this codebase has had was invisible until the relevant counter/error was surfaced in the response.

## Current match reality (as of last verification)

Every pair below was read and confirmed by hand; the counts are small on
purpose. A wrong pair renders a fake arbitrage, so precision beats recall.

| Category | Stored pairs | Shown on site | Floor |
|---|---|---|---|
| economics | 1 | 1 | 0.78 |
| crypto | 17 | 12 | 0.90 |
| politics | 14 | 5 | 0.94 |

"Shown" is lower than "stored" because `markets.js` drops prices outside
0.05–0.95, and the extra politics pairs are long shots (the seven-person
Venezuela set, pardon markets) trading under a nickel.

Economics: **1 verified-correct pair** out of 163 Kalshi econ markets. That is the genuine overlap, not a bug — the full uncapped `topScores` list was audited and every other Kalshi CPI/Fed-rate/GDP row's best candidate is a legitimately different market (wrong threshold, wrong country, or hike-count-vs-rate-level). Kalshi lists ~9 GDP threshold buckets per quarter where Polymarket lists one. Adding Polymarket's "interest rates" tag (131) produced 16 candidates, 15 of them ECB/Bank of England — all correctly filtered out.

Crypto's floor sits at 0.90, not 0.94, because Kalshi phrases every
strike as "<COIN> trimmed mean be above $X" against Polymarket's "Will
<Coin> reach $X" — real matches land at 0.91–0.93, and 0.94 admitted
nothing at all. The strike and deadline gates do the rejecting instead
of the score. **0.90 is a gate limit, not a tuning preference**: below
it, Kalshi's "Which of these cryptocurrencies will have a positive
return in 2026?" family starts pairing with unrelated strike markets
("Will Chainlink reach $26?", "Solana all time high?") and nothing
currently catches it. Handling that claim type is what would let the
floor come down to ~0.88, which is worth about 5 more correct pairs.

## v2 schema (live, running alongside v1)

The v1 model can't express a third venue or a multi-outcome market (see `docs/architecture-v2.md` for the full argument). The v2 schema is **built and backfilled**, running in parallel — v1 still serves the live site.

- **Migrations now live in `supabase/migrations/`.** Run them in the Supabase SQL editor; both are idempotent.
  - `0001_v2_schema.sql` — `events` → `outcomes` → `listings` → `quotes`, plus `latest_quotes` and `v2_market_view`.
  - `0002_v2_rls.sql` — RLS on v2 tables only (v1's posture is untouched so the live path can't break).
- **Writes to v2 tables need `SUPABASE_SERVICE_ROLE_KEY`** (set in Vercel). It bypasses RLS; anon is SELECT-only. Server-side API routes only — never a `NEXT_PUBLIC_*` var. `lib/v2/db.js` falls back to anon and reports `credentialInUse()` so a missing key fails loudly.
  - Vercel only exposes an env var to deployments built *after* it's added. Adding the key without redeploying reads as `credential: "anon"`.
- **Routes**: `/api/v2/health` (credential + live RLS probe + row counts), `/api/v2/backfill` (`?dry=1`, `?category=`), `/api/v2/markets` (read path).
- **Current state**: 67 events, 134 outcomes, 2566 listings (268 matched / 2298 unmatched), 2566 quotes. Re-running backfill is a no-op.

Key v2 design points:
- `listings` are unique on `(venue_id, venue_market_id, side)`. One Kalshi binary ticker is tradable from both sides and its no-side has its own bid/ask — **not** `1 − yes` — so each side needs its own quote stream.
- `listings.outcome_id` is nullable by design; unmatched is a valid state and those rows are the review-queue backlog.
- `quotes` is append-only and **write-on-change** (`lib/v2/quotes.js`), with a 6h heartbeat. Unconditional 5-min polling would be ~170k rows/day and fill the 500MB free tier in ~a month recording duplicates. It's also the only table that cannot be backfilled.
- `lib/v2/claims.js` holds the claim extractors, imported by both `embed.js` and the v2 layer — v2 persists these as columns, so a divergent copy would write wrong data rather than just misreport it.

### LLM claim extraction (evaluated, not yet wired in)

`lib/v2/extract.js` extracts structured resolution claims via the Claude API, as the eventual replacement for the regex gate. Model choice was decided by measurement — see `docs/extraction-model-eval.md`.

- **Use `claude-haiku-4-5`.** It matched Sonnet 5 and Opus 5 on every measured axis (16/16 labeled decisions, zero regressions vs regex) at ~1/6 the cost and half the latency. ~$0.51 per 1k markets; the full 1,283-title backfill is ~$0.66.
- Coverage roughly doubles vs regex (extracts a claim on ~50 of 100 markets where regex returns nothing) with zero cases where regex saw something the LLM missed.
- **The eval saturated** — all three models scored 100%, so it cannot discriminate on accuracy. Add harder cases before trusting any of them on a new venue's phrasing.
- Nullable enums in the JSON schema must use `anyOf: [{type,enum},{type:"null"}]`. A `type: ["string","null"]` union alongside `enum` is rejected with a 400.
- Run one model per `/api/v2/extract-eval` request; three models x 100 markets exceeds the Vercel function timeout.
- Requires `ANTHROPIC_API_KEY` in Vercel env (and a redeploy, same as the service-role key).

**Arb numbers from `/api/v2/markets` are not yet executable.** v1 never stored bid/ask, so backfilled quotes have `mid` only and the arb calc falls back to it; fees aren't modelled either (`feesIncluded: false`). Treat any edge as "worth checking", not a trade, until ingestion writes real bid/ask and fees land.

## v1 database (Supabase, schema still dashboard-only)

The v1 `markets`/`pairs` schema and the `get_pairs` RPC live only in the Supabase dashboard — that SQL is not checked in. Changes must be made there directly.

- **`markets`** — one row per market side. `id` (text PK — Kalshi IDs start with `KX`, Polymarket IDs are numeric strings), `platform`, `title`, `embedding` (JSON, null for sports), `yes_price`, `no_price`, `volume`, `sport_tag`, `event_ticker`, `side_label`, `slug`, `outcomes`, `outcome_prices`, `updated_at`. `platform` is NOT NULL — this matters, see pitfalls.
- **`pairs`** — `id` (serial), `kalshi_id`, `polymarket_id`, `similarity`, `created_at`. UNIQUE on `(kalshi_id, polymarket_id)`.

```sql
CREATE OR REPLACE FUNCTION get_pairs(sport_tags text[])
RETURNS TABLE (
  kalshi_id text, polymarket_id text, similarity float,
  k_title text, k_yes_price float, k_no_price float, k_volume float,
  k_sport_tag text, k_event_ticker text, k_side_label text, k_close_time text,
  p_title text, p_yes_price float, p_no_price float, p_volume float,
  p_slug text, p_side_label text, p_outcomes text, p_outcome_prices text
) AS $$
  SELECT p.kalshi_id, p.polymarket_id, p.similarity,
    k.title, k.yes_price, k.no_price, k.volume, k.sport_tag, k.event_ticker, k.side_label, k.close_time,
    pm.title, pm.yes_price, pm.no_price, pm.volume, pm.slug, pm.side_label, pm.outcomes, pm.outcome_prices
  FROM pairs p
  JOIN markets k ON k.id = p.kalshi_id
  JOIN markets pm ON pm.id = p.polymarket_id
  WHERE k.sport_tag = ANY(sport_tags)
  ORDER BY p.similarity DESC
$$ LANGUAGE sql SECURITY DEFINER;
```

## Known pitfalls (don't re-discover these)

### Supabase

- **A paused free-tier project is the first thing to check when writes silently fail.** Free-tier Supabase auto-pauses after inactivity; DNS then fails to resolve the project host entirely. The symptom is `TypeError: fetch failed` with `cause.code === "ENOTFOUND"`, and unchecked `const { data } = await supabase...` calls just yield `undefined`/`[]`, so it looks like "no rows" rather than an outage. This burned most of a debugging session. Always surface `error`, and check `cause.code` before theorizing about query shape.
- **`upsert()` with a partial column set fails on NOT NULL columns even when the row already exists.** `INSERT ... ON CONFLICT DO UPDATE` validates the attempted insert row *before* resolving the conflict, so sending `{id, embedding, updated_at}` into `markets` fails every row with `23502 null value in column "platform"`. Either send the full row, or use a plain `.update()`.
- **Selects silently cap at 1000 rows.** Any unbounded `.select()` on `markets` needs an explicit `.limit()` and, where applicable, a `sport_tag` filter. This bit both `refresh.js` and `embed.js`'s matchonly query.
- `supabase-js` flattens network-layer errors to a bare `"TypeError: fetch failed"` string. Where the real cause matters, the raw REST helpers in `embed.js`/`refresh.js` (`restFetch`, `upsertRows`) preserve `cause.code` and HTTP status/body.
- **`.in()` puts its values in the query string, so a few thousand ids build a URL long enough to kill the request.** Clearing politics' pairs meant `.in("kalshi_id", [...1774 ids])` — a ~40KB URL — and supabase-js returns that as an error object the call sites were ignoring, so clearing looked like it worked. The visible symptom was a re-match at a corrected threshold writing its new pairs while every stale wrong one survived. Chunk at ~200 ids and check the error.
- Non-sports matching in normal mode must clear existing pairs for the category before rematching, or stale wrong pairs survive: upsert only overwrites when *both* ids match, so a Kalshi row matching a *different* Polymarket market just adds a second row.

### Kalshi

- Base URL must be `https://api.elections.kalshi.com/trade-api/v2` — `api.kalshi.com` and `trading-api.kalshi.com` are wrong/dead.
- Prices come from `yes_ask_dollars`/`yes_bid_dollars` as decimal strings (`"0.4200"`), not the `_fp` fields (those return `"0.00"`).
- Default `/markets` is dominated by `KXMVE*` parlay tickers — always filter `!ticker.startsWith("KXMVE")`.
- **Web URLs**: only the series-level page reliably resolves — `kalshi.com/markets/kxgdp`, `kalshi.com/markets/KXFED`. A path built from the full market ticker 404s. Event-level pages need a human-readable slug (`kalshi.com/markets/kxgdpyear/annual-gdp`) that the API doesn't give us, so `markets.js` links to the series page.

### Polymarket

- Default `/markets?active=true&closed=false` only returns high-volume *featured* markets. Individual markets require `/events?tag_id=X` with `offset` pagination. Only numeric `tag_id` filters — `tag=`, `label=`, `search=` are silently ignored.
- Polymarket publishes no fixed tag list; discover IDs by paging `/tags` and matching label/slug. Known: soccer `100350`, nba `745`, nhl `899`, mlb `100381`, federal reserve `129`, interest rates `131`, Macro Inflation `101249`, recession `100201`, GDP `370`.
- The `?id=` batch filter needs the key repeated (`?id=1&id=2`), not comma-joined.
- **`?id=` silently omits closed markets** unless `closed=true` is also passed, and a non-integer id 422s the *whole batch*. Both are why `/api/refresh` returns fewer Polymarket rows than it asked for; the omission is correct behaviour for us (a closed market should not display), the 422 was not, and is now filtered on.
- The "event has ≤4 markets" heuristic separates single games from tournament futures for **sports only** — a Fed decision legitimately has more outcomes. `fetchPolymarkets()` skips that filter for non-sports tags.
- `outcomePrices` doesn't always align index-for-index with `outcomes`. Still unfixed; mitigated only by the ≤15pt arb spread guard.

### Matching generally

- Bulk keyword/fuzzy matching across all markets (the original approach) produced repeated false positives — cross-sport matches on shared words, tournament-winner markets matching single games, sibling markets within an event getting swapped, date noise diluting scores. Hence per-category scoping and structured gates.
- Game dates live in IDs, not separate fields: Kalshi `KXMLBGAME-26AUG121940CINCWS` → Aug 12 2026; Polymarket slug `mlb-cin-cws-2026-08-12` → same. `datesCompatible()` allows 6 hours for UTC/ET edges.

## Known bugs / open work (priority order)

1. **Arb numbers are not executable** — v1 never stored bid/ask and no fee model exists, so every edge shown is a mid-to-mid estimate. Treat as "worth checking", never as a trade.
2. **Polymarket outcome-price ordering** — `outcomePrices` vs `outcomes` index misalignment can attribute the wrong side's price. A sanity check (`prices[0] + prices[1] ≈ 1.0`, both in 0.05–0.95) would catch a misindexed pick.
3. **Sports still uses rule-based matching only** — no embeddings. The planned direction is the same hybrid as econ: embeddings generate candidates, structured rules (date + side/outcome label) verify them, which removes the hand-maintained per-league team-alias maps without reintroducing sibling-swap bugs.
4. **Soccer matching is unreliable** — World Cup games sometimes pair with the wrong Polymarket market.
5. **No gate for "positive return"-style claims** — a Kalshi multi-outcome market like "Which of these cryptocurrencies will have a positive return in 2026?" has no threshold, no deadline of its own, and no unit, so every gate falls through and it pairs with any strike market on the same coin. This is the only thing holding crypto's floor at 0.90 instead of ~0.88.
6. Date-window tuning is a tradeoff: tightening the 6-hour `datesCompatible()` window risks missing same-day matches across UTC/ET; loosening it risks matching different games in a back-to-back series.

**Fixed since the last revision of this file:** automated refresh (both
GitHub Actions workflows), crypto and politics wired end to end, the
1000-row server-side cap, and `.in()`-based pair clearing.
