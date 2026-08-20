# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Housedge is a prediction-market odds comparison dashboard: it pulls live markets from Kalshi and Polymarket, matches equivalent markets across the two platforms, and displays side-by-side odds with arbitrage alerts.

## Commands

- `npm run dev` — start dev server at http://localhost:3000
- `npm run build` — production build
- `npm start` — run production build
- No lint or test scripts are configured.
- `node explore.js` — standalone debug script for paginating/inspecting the Polymarket API directly (not part of the app, run separately from `npm run dev`).

## Environment variables

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — required, all data flows through Supabase.
- `VOYAGE_API_KEY` — required for `/api/embed` on non-sports categories (Voyage AI embeddings).
- `KALSHI_API_KEY` — present in `.env.local` but currently unused; Kalshi market data is public and needs no auth.

## Architecture: three-stage pipeline through Supabase

The frontend never calls Kalshi/Polymarket directly. Data flows through three separate API routes that run at different cadences:

1. **`pages/api/embed.js`** — the expensive, infrequent job. Fetches raw markets from both platforms, upserts them into the Supabase `markets` table, and computes cross-platform matches into a `pairs` table. Two different matching strategies depending on category:
   - **Sports (mlb/nba/nhl/soccer)**: structured matching — extracts both team names from each title (via `MLB_TEAMS`-style alias maps and regex on Kalshi's "Team A vs Team B" / Polymarket's "Will Team A win" formats), requires both teams to match, and gates on game date being within 6 hours. No embeddings involved.
   - **Economics/crypto/politics**: semantic matching — titles are embedded with Voyage AI (`voyage-3.5-lite`) and matched by cosine similarity against a threshold (`?threshold=`, default 0.78).
   - Query params: `?sport=mlb|nba|nhl|soccer|econ|...` (scope to one category), `?matchonly=1` (re-run matching on already-stored markets without re-fetching), `?force=1` (re-embed/re-match everything).
   - This route is triggered manually or by a scheduled job — it is not called by the page. The UI surfaces a "needs embed" state with a manual trigger link when a category has no pairs yet.

2. **`pages/api/refresh.js`** — the cheap, frequent job (meant to run on a schedule, e.g. cron). Only updates price/volume fields for markets *already* in the `markets` table — it does not discover new markets or recompute matches.

3. **`pages/api/markets.js`** — what the frontend actually polls (every 60s). Calls a Postgres RPC function `get_pairs(sport_tags)` that joins `markets` and `pairs` directly in SQL. **Note: the SQL for `get_pairs` and the Supabase schema (`markets`, `pairs` tables) live only in the Supabase dashboard — there are no migrations checked into this repo.** Filters out stale/expired-date rows and prices outside 0.05–0.95, then shapes the response for the UI.

`pages/index.js` is a single-file client (category tabs, sort controls, market cards, arb badges) using inline styles — no CSS framework. Arb logic: `min(kalshi.yes, poly.yes) + min(kalshi.no, poly.no) < 0.97` AND spread ≤ 15 points (larger spreads are treated as data errors, not real arbitrage, per hard-won experience below).

## Known pitfalls (don't re-discover these)

- **Kalshi base URL** must be `https://api.elections.kalshi.com/trade-api/v2` — `api.kalshi.com` and `trading-api.kalshi.com` are both wrong/dead.
- Kalshi prices come from `yes_ask_dollars`/`yes_bid_dollars` as decimal strings (`"0.4200"`), not the `_fp`-suffixed fields (those return placeholder `"0.00"`).
- Kalshi's default `/markets` endpoint is dominated by `KXMVE*` parlay tickers — always filter `!ticker.startsWith("KXMVE")`.
- Polymarket's default `/markets?active=true&closed=false` only returns high-volume *featured* markets. Individual game markets require `/events?tag_id=X` with `offset` pagination. Only numeric `tag_id` works as a filter — `tag=`, `label=`, `search=` are silently ignored.
- Known Polymarket tag IDs (see `POLY_TAGS` in `embed.js`): soccer `100350`, nba `745`, nhl `899`, mlb `100381`.
- Bulk keyword/fuzzy matching across all markets (the original approach) produced repeated false positives — cross-sport matches on shared words, tournament-winner markets matching single games, sibling markets within the same event getting swapped, date noise diluting scores. This is why sports use structured team+date extraction instead of embeddings, and why matching is scoped per-category rather than done globally.
