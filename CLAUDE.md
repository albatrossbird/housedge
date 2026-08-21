# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Housedge is a prediction-market odds comparison dashboard: it pulls live markets from Kalshi and Polymarket, matches equivalent markets across the two platforms, and displays side-by-side odds with arbitrage alerts.

- **Live site**: https://housedge.vercel.app
- **Supabase project**: smoewpcbpjfcqpyswyli.supabase.co
- Deployment is automatic on every push to `main` (Vercel). There is no separate staging environment.

## Commands

- `npm run dev` — start dev server at http://localhost:3000
- `npm run build` — production build
- `npm start` — run production build
- No lint or test scripts are configured.
- `node explore.js` — standalone debug script for paginating/inspecting the Polymarket API directly (not part of the app, run separately from `npm run dev`).

## Environment variables

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — required, all data flows through Supabase. Set in Vercel dashboard for prod, `.env.local` for local dev.
- `VOYAGE_API_KEY` — required for `/api/embed` on non-sports categories (Voyage AI embeddings, free tier).
- `KALSHI_API_KEY` — present in `.env.local` but currently unused; Kalshi market data is public and needs no auth.

## Architecture: three-stage pipeline through Supabase

The frontend never calls Kalshi/Polymarket directly. Data flows through three separate API routes that run at different cadences:

1. **`pages/api/embed.js`** — the expensive, infrequent job. Fetches raw markets from both platforms, upserts them into the Supabase `markets` table, and computes cross-platform matches into a `pairs` table. Two different matching strategies depending on category:
   - **Sports (mlb/nba/nhl/soccer)**: structured matching — extracts both team names from each title (via `MLB_TEAMS`-style alias maps and regex on Kalshi's "Team A vs Team B" / Polymarket's "Will Team A win" formats), requires both teams to match, and gates on game date being within 6 hours. No embeddings involved.
   - **Economics/crypto/politics**: semantic matching — titles are embedded with Voyage AI (`voyage-3.5-lite`) and matched by cosine similarity against a threshold (`?threshold=`, default 0.78).
   - Query params: `?sport=mlb|nba|nhl|soccer|econ|...` (scope to one category), `?matchonly=1` (re-run matching on already-stored markets without re-fetching), `?force=1` (re-embed/re-match everything).
   - Not called by the page — triggered manually (or should be, by a scheduled job — see Known bugs). The UI surfaces a "needs embed" state with a manual trigger link when a category has no pairs yet.

2. **`pages/api/refresh.js`** — *intended* to be the cheap, frequent job that keeps prices current between embed runs by updating price/volume fields for markets already in the `markets` table, without rediscovering markets or recomputing matches. **Currently broken — see Known bugs.**

3. **`pages/api/markets.js`** — what the frontend actually polls (every 60s). Calls a Postgres RPC function `get_pairs(sport_tags)` that joins `markets` and `pairs` directly in SQL (chained Supabase JS client filters were silently failing, which is why this went through a raw SQL RPC instead). Filters out stale/expired-date rows and prices outside 0.05–0.95, then shapes the response for the UI.

`pages/index.js` is a single-file client (category tabs, sort controls, market cards, arb badges) using inline styles — no CSS framework. Arb logic: `min(kalshi.yes, poly.yes) + min(kalshi.no, poly.no) < 0.97` AND spread ≤ 15 points (larger spreads are treated as data errors, not real arbitrage — see the Polymarket outcome-price bug below).

### Manually refreshing data (until cron exists)

```
/api/embed?sport=mlb              # fetch + store + match one category
/api/embed?matchonly=1&sport=mlb  # re-match without re-fetching
```
Repeat per sport/category. `/api/refresh` is supposed to do this automatically but is currently broken (see below).

## Database (Supabase, no migrations in this repo)

Schema and the RPC function below live only in the Supabase dashboard — there is no SQL checked into this repo. If you change either, the change has to be made there directly (or a migrations setup added).

- **`markets`** — all Kalshi + Polymarket markets, one row per market side. Key fields: `id` (text PK — Kalshi IDs start with `KX...`, Polymarket IDs are numeric strings), `platform`, `title`, `embedding` (JSON, null for sports), `yes_price`, `no_price`, `volume`, `sport_tag`, `event_ticker`, `side_label`, `slug`, `outcomes`, `outcome_prices`, `updated_at`.
- **`pairs`** — confirmed cross-platform matches. `id` (serial), `kalshi_id`, `polymarket_id`, `similarity` (float), `created_at`. UNIQUE on `(kalshi_id, polymarket_id)`.

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

- **Kalshi base URL** must be `https://api.elections.kalshi.com/trade-api/v2` — `api.kalshi.com` and `trading-api.kalshi.com` are both wrong/dead.
- Kalshi prices come from `yes_ask_dollars`/`yes_bid_dollars` as decimal strings (`"0.4200"`), not the `_fp`-suffixed fields (those return placeholder `"0.00"`).
- Kalshi's default `/markets` endpoint is dominated by `KXMVE*` parlay tickers — always filter `!ticker.startsWith("KXMVE")`.
- Polymarket's default `/markets?active=true&closed=false` only returns high-volume *featured* markets. Individual game markets require `/events?tag_id=X` with `offset` pagination. Only numeric `tag_id` works as a filter — `tag=`, `label=`, `search=` are silently ignored.
- Known Polymarket tag IDs (see `POLY_TAGS` in `embed.js`): soccer `100350`, nba `745`, nhl `899`, mlb `100381`.
- Game dates are embedded in IDs, not fetched separately: Kalshi ticker `KXMLBGAME-26AUG121940CINCWS` → Aug 12 2026; Polymarket slug `mlb-cin-cws-2026-08-12` → same. `datesCompatible()` allows up to 6 hours difference to absorb UTC/ET edge cases.
- Bulk keyword/fuzzy matching across all markets (the original approach) produced repeated false positives — cross-sport matches on shared words, tournament-winner markets matching single games, sibling markets within the same event getting swapped, date noise diluting scores. This is why sports use structured team+date extraction instead of embeddings, and why matching is scoped per-category rather than done globally.

## Known bugs (priority order)

1. **`/api/refresh` is broken** — returns `{"kalshiUpdated":0,"polyUpdated":0}`. Prices go stale after an embed run, which can produce fake arb signals. Suspected cause: Kalshi upsert format mismatch and/or the Polymarket batch `?id=` query format being wrong.
2. **Polymarket outcome-price ordering** — `outcomePrices` doesn't always align index-for-index with `outcomes`, so team-name-to-price lookups can grab the wrong side. Currently only mitigated by the ≤15pt spread guard on arb alerts, not fixed. A sanity check (`outcomePrices[0] + outcomePrices[1] ≈ 1.0`, both in 0.05–0.95) could catch a misindexed pick.
3. **No automated refresh** — data only updates when someone manually visits the `/api/embed` URLs; needs a Vercel cron (or similar) once `/api/refresh` is fixed.
4. **Soccer matching is unreliable** — World Cup games sometimes pair with the wrong Polymarket market.
5. Date-window tuning is a tradeoff: tightening the 6-hour `datesCompatible()` window risks missing legitimate same-day matches across UTC/ET, but loosening it risks matching different games in a back-to-back series.
