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

2. **`pages/api/refresh.js`** — the cheap, frequent job. Updates price/volume for markets already in `markets` without rediscovering or rematching. **Working** (verified 163 Kalshi / 107 Polymarket rows updated). Still needs a cron to run automatically — until then prices go stale between manual hits, which is the usual explanation for "the site shows a price that's hours old."

3. **`pages/api/markets.js`** — what the frontend polls (every 60s). Calls the `get_pairs(sport_tags)` Postgres RPC, which joins `markets` and `pairs` in SQL (chained Supabase JS-client filters were silently failing, hence the raw RPC). Filters stale/expired-date rows and prices outside 0.05–0.95, then shapes for the UI.

`pages/index.js` is a single-file client (category tabs, sort controls, market cards, arb badges) with inline styles — no CSS framework. Arb logic: `min(kalshi.yes, poly.yes) + min(kalshi.no, poly.no) < 0.97` AND spread ≤ 15 points (larger spreads are treated as data errors, not real arbitrage — see the Polymarket outcome-price bug).

### Manually refreshing data (until cron exists)

```
/api/refresh                      # prices only, cheap, safe to hit often
/api/embed?sport=econ             # fetch + store + embed + match one category
/api/embed?matchonly=1&sport=econ # re-match only (no fetch, no re-embed) — use for threshold/gate iteration
/api/embed?force=1&sport=econ     # re-embed everything (needed after an embedding-model change)
```

## Scalar-market matching (the core non-sports problem)

Embedding similarity alone **does not work** for threshold markets, and this is not fixable by tuning the threshold. Kalshi models GDP/CPI/Fed-rate as a family of ~9 near-identical binary questions per period ("above 0.5%", "above 1.0%", … "above 4.0%"); their titles share ~95% of their text, so wrong-threshold pairs score *higher* (0.88–0.93) than any cutoff that would still admit real matches. An audit of 43 embedding-only pairs found nearly all wrong.

The fix is embeddings for candidate generation + a **hard signature gate** before acceptance, in `embed.js`:

- `extractNumericClaim(title)` → `{unit, op, value|low/high}`. Units are `percent`, `count` ("5 or more rate hikes"), `bps` ("25 bps increase"). A **unit mismatch is always incompatible** — a rate-*level* question is not a rate-*hike-count* question even though they're correlated.
- `extractPeriod(title)` → `{quarter, year}`.
- `mentionsNonUsRegion(title)` — Kalshi's econ series (KXFED/KXCPI/KXGDP/KXRECESSION) are implicitly US-only and never say "US", while Polymarket covers many countries with identical phrasing and thresholds. Blocks country names **and their adjective forms** (`\bjapan\b` does not match "Japanese") **and** foreign central banks (ECB, BOE, BOJ, …), which name no country at all. Scoped to `sportTag === "econ"` since it's a fact about that Kalshi series, not a general rule.
- `scalarSignaturesCompatible(a, b, sportTag)` combines them. **Reject only when both sides have an extractable signature and it disagrees** — anything unrecognized falls through to embedding score alone, so the extractors don't need to understand every phrasing to be useful.

Matching is **globally greedy**: build all gate-passing `(kalshi, poly, score)` candidates, sort by score descending, then assign. Assigning per-Kalshi-row in DB order (the old way) meant whichever row was processed first claimed a contested Polymarket market, not the best-scoring one.

`matchNonSportsMarkets()` is shared by both `matchonly` and normal mode. They were separately duplicated for a while and drifted (a diagnostic added to one branch, missing in the other) — keep them unified.

### Diagnostics convention

Both modes return `matchDiagnostics` with `threshold`, embedded counts, `acceptedPairs` (what was actually paired, post-gate, post-exclusivity), and `topScores` (best candidate per Kalshi row **regardless of threshold or gate**). `topScores` is what distinguishes "real candidates just under threshold" from "nothing close" from "gate correctly rejecting". Write routes return per-stage `writes` counts and real error strings. **Keep this** — nearly every bug this codebase has had was invisible until the relevant counter/error was surfaced in the response.

## Current match reality (as of last verification)

Economics: **1 verified-correct pair** out of 163 Kalshi econ markets. That is the genuine overlap, not a bug — the full uncapped `topScores` list was audited and every other Kalshi CPI/Fed-rate/GDP row's best candidate is a legitimately different market (wrong threshold, wrong country, or hike-count-vs-rate-level). Kalshi lists ~9 GDP threshold buckets per quarter where Polymarket lists one. Adding Polymarket's "interest rates" tag (131) produced 16 candidates, 15 of them ECB/Bank of England — all correctly filtered out.

## Database (Supabase, no migrations in this repo)

Schema and the RPC live only in the Supabase dashboard — no SQL is checked into this repo. Changes must be made there directly (or a migrations setup added).

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
- The "event has ≤4 markets" heuristic separates single games from tournament futures for **sports only** — a Fed decision legitimately has more outcomes. `fetchPolymarkets()` skips that filter for non-sports tags.
- `outcomePrices` doesn't always align index-for-index with `outcomes`. Still unfixed; mitigated only by the ≤15pt arb spread guard.

### Matching generally

- Bulk keyword/fuzzy matching across all markets (the original approach) produced repeated false positives — cross-sport matches on shared words, tournament-winner markets matching single games, sibling markets within an event getting swapped, date noise diluting scores. Hence per-category scoping and structured gates.
- Game dates live in IDs, not separate fields: Kalshi `KXMLBGAME-26AUG121940CINCWS` → Aug 12 2026; Polymarket slug `mlb-cin-cws-2026-08-12` → same. `datesCompatible()` allows 6 hours for UTC/ET edges.

## Known bugs / open work (priority order)

1. **No automated refresh** — `/api/refresh` works but nothing calls it. Needs a Vercel cron. This is the cause of visibly stale prices on the live site.
2. **Polymarket outcome-price ordering** — `outcomePrices` vs `outcomes` index misalignment can attribute the wrong side's price. A sanity check (`prices[0] + prices[1] ≈ 1.0`, both in 0.05–0.95) would catch a misindexed pick.
3. **Sports still uses rule-based matching only** — no embeddings. The planned direction is the same hybrid as econ: embeddings generate candidates, structured rules (date + side/outcome label) verify them, which removes the hand-maintained per-league team-alias maps without reintroducing sibling-swap bugs.
4. **Soccer matching is unreliable** — World Cup games sometimes pair with the wrong Polymarket market.
5. **Crypto/politics categories are unwired** — `POLY_TAGS` has no entries; UI shows "coming soon". Candidate tags: Crypto `21`, Politics `2`.
6. Date-window tuning is a tradeoff: tightening the 6-hour `datesCompatible()` window risks missing same-day matches across UTC/ET; loosening it risks matching different games in a back-to-back series.
