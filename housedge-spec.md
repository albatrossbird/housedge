# Housedge — Project Spec & Running Log

**Last updated:** This session (continue from here in a new chat)

## What this is
A prediction market odds comparison dashboard — pulls live markets from Kalshi and Polymarket, matches equivalent markets across both platforms, displays side-by-side odds, flags arbitrage opportunities.

## Current local setup
- Path: `C:\Users\nicol\housedge`
- Stack: Next.js (Pages Router, no TypeScript, no Tailwind), React inline styles
- Run locally: `cd ~/housedge && npm run dev` → http://localhost:3000
- Git Bash inside Windows Terminal
- `.env.local` has `KALSHI_API_KEY` (currently unused — Kalshi market data is public, no auth needed)

## Key files
- `pages/index.js` — main dashboard UI + matching logic (client-side)
- `pages/api/markets.js` — server-side proxy that fetches Kalshi + Polymarket data (avoids CORS)
- `explore.js` — standalone debug script (run with `node explore.js`, NOT `npm run dev`) used to paginate/inspect Polymarket events

## Architecture decision: category-based browsing (current direction)
Originally tried fully automatic bulk matching (compare every Kalshi market against every Polymarket market with keyword scoring). This caused repeated false-match bugs:
- "Real GDP" matched "CD Real Tomayapo" (soccer team) — shared word "real"
- Tournament-winner markets matched single-game markets — "Turkiye vs USA" matched "Will the US win the World Cup"
- Sibling markets within the same event got confused — "New Zealand wins" matched against "Belgium wins" or "Tie" for the same game
- Date noise in Polymarket titles ("Will X win on 2026-01-19?") diluted keyword coverage scores

**New direction (in progress):** User clicks a category tab (Sports/Economics/Crypto/Politics) — this IS the category gate, no text-detection needed. Eliminates cross-category bugs by construction. Within a category, still need:
1. Structure-phrase gating (halftime vs full-match, tournament-winner vs single-game)
2. Side-label alias matching (team name variants across platforms)
3. Date-stripping from keywords

This is documented in code comments in the latest `index.js`/`markets.js`.

## API learnings (important — don't re-discover these)

### Kalshi
- Public market data needs NO auth — `KALSHI_API_KEY` currently unused
- Correct base URL: `https://api.elections.kalshi.com/trade-api/v2` (NOT `api.kalshi.com` or `trading-api.kalshi.com` — both wrong/dead)
- Default `/markets` endpoint is dominated by `KXMVE*` tickers — multivariate parlay combos, not single markets. MUST filter: `!ticker.startsWith("KXMVE")` and `!title.includes(",yes ")`
- Fetch by `series_ticker` param to get clean single-market data, e.g. `?series_ticker=KXWCGAME&status=open&limit=50`
- Prices are in `yes_ask_dollars` / `yes_bid_dollars` / `last_price_dollars` as **decimal strings** like `"0.4200"` — NOT cents, NOT the `_fp` suffixed fields (those are something else, returned "0.00" placeholder values)
- For multi-outcome events (e.g. "Congo DR vs Uzbekistan Winner?"), each side has its own market row with the same `title` but different `yes_sub_title` (e.g. "Uzbekistan", "Tie", "Congo DR") and `event_ticker` groups them
- Known working series tickers: `KXWCGAME` (World Cup games), `KXWCCHAMP` (WC winner futures), `KXNHL`, `KXNBA`, `KXMLB`, `KXBTC`, `KXETH`, `KXFED`, `KXCPI`, `KXPRES`, `KXRECESSION`, `KXGDP`
- KXNHL pulled 2026-27 season Stanley Cup futures (tournament-winner style, one market per team) — need to check if individual NHL games need a different series ticker

### Polymarket
- Base URL: `https://gamma-api.polymarket.com` — fully public, no auth
- **Critical discovery:** the default `/markets?active=true&closed=false` endpoint only surfaces high-volume FEATURED markets (tournament winners, celebrity bets) — individual game markets exist but are NOT in this default list
- **The fix:** use `/events?tag_id=X&active=true&closed=false` with pagination (`offset` += 50 each call), then filter by market count per event:
  - 2-4 markets per event = individual outcome (Team A win / Team B win / Tie, or single Yes/No)
  - 5+ markets per event = tournament futures (one market per competing team/entity)
- Verified working tag IDs:
  - `100350` = Soccer (confirmed working — found 482 individual games via this method)
  - `370` = GDP (found, NOT YET VERIFIED if it covers all econ or just GDP specifically)
  - `745` = NBA (found via web research, NOT YET TESTED)
  - `864` = Tennis (found via web research, NOT YET TESTED)
- There's a dedicated `/sports` endpoint (`https://gamma-api.polymarket.com/sports`) that should return sport metadata INCLUDING associated tag IDs directly — better than guessing through `/tags`. WAS ABOUT TO TEST THIS WHEN SESSION ENDED.
- `/tags?limit=100` returns essentially random/unhelpful results — thousands of tags exist, this isn't useful for browsing, only good for confirming a specific known tag's ID/label pair
- Query params that DON'T work (silently ignored, return default unfiltered list): `tag=soccer` (string label), `label=X`, `search=X` — only numeric `tag_id` works
- Each market within an event has a `groupItemTitle` field with the specific side name (e.g. "New Zealand") — critical for matching the correct sibling market within a multi-outcome event
- `outcomePrices` is a JSON-stringified array like `["0.52", "0.48"]` — first value is YES price
- Individual game titles often embed dates: "Will Çaykur Rizespor win on 2026-01-19?" — strip pure-number tokens from keywords or date noise dilutes match scores

## Known bugs fixed this session
1. Wrong Kalshi base URL (404/401 errors) → fixed to `api.elections.kalshi.com`
2. Kalshi price field misread as cents/fp format → fixed to decimal string fields
3. Cross-category false matches (GDP/soccer) → fixed via category gate (was per-text-detection, now per-tab-click)
4. Tournament-winner vs single-game cross-matching → fixed via STRUCTURE_PHRASES signature check
5. Sub-bet cross-matching (full match vs halftime result) → fixed via expanded STRUCTURE_PHRASES list
6. Sibling-market confusion within same event → fixed via `groupItemTitle`/`sideLabel` matching requirement
7. Date noise diluting match scores → fixed via stripping pure-number tokens from keywords

## Next steps (in priority order)
1. **Test `/sports` endpoint** — `curl "https://gamma-api.polymarket.com/sports"` — should give clean tag IDs for all sports including NHL/MLB in one call
2. **Verify tag_id 745 (NBA) and 864 (Tennis)** work with the events+pagination method
3. **Find correct tag_id for NHL and MLB** (not yet found)
4. **Verify tag_id 370 (GDP)** actually covers Fed/CPI/recession or if those need separate tags
5. **Find tag_id for Crypto and Politics** categories (currently `null` placeholders in code, UI shows "coming soon")
6. Once category browsing works well for 2+ categories, build the search feature (semantic/keyword matching anchored by user query instead of blind bulk matching)
7. After search works, build curated homepage (5-10 hand-verified high-confidence pairs)
8. GitHub setup + Vercel deployment (account created, repo not yet initialized — Git was initialized locally by create-next-app)
9. Mobile responsive polish
10. Consider semantic/embedding-based matching as upgrade over keyword overlap (per research: production bots mostly use curated pairs + embedding similarity scores, not pure fuzzy text matching)

## Business/product context (from earlier sessions)
- Target pricing: $15-25/month Pro tier
- Competitor: OddsJam charges ~$199/month, acquired for ~$160M (validates market exists)
- Name: keeping "housedge" for prototype phase; alternatives considered if rebranding later: Spreadline, Spredge, Oddstack, Crosslines, Linewise (Spredge was favorite alternative)
- Go-to-market: Twitter/X build-in-public, Kalshi/Polymarket Discord communities, ProductHunt/Hacker News for beta
- Recommended hosting: Railway or Render (~$10-20/mo), Postgres, cache odds on schedule not per-request
