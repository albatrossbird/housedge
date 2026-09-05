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
   - **Sports (mlb/nba/nhl/soccer)**: an exact join on the game identifier, not a text match — see "Sports matching" below. No embeddings, no similarity score.
   - **Economics/crypto/politics**: `matchNonSportsMarkets()` — Voyage AI (`voyage-4-large`) embeddings + cosine similarity above `?threshold=` (default 0.78), **then** a hard signature gate (see "Scalar-market matching" below).
   - Query params: `?sport=mlb|nba|nhl|soccer|econ|...`, `?matchonly=1` (re-match stored markets without re-fetching or re-embedding), `?force=1` (re-embed/re-match everything), `?threshold=`.
   - Not called by the page — triggered manually or by a scheduled job (no cron exists yet).

2. **`pages/api/refresh.js`** — the cheap, frequent job. Updates price/volume for markets already in `markets` without rediscovering or rematching. Runs every ~15 minutes from GitHub Actions (see "Automation"). Scoped to markets that appear in `pairs`; last verified run refreshed 46 Kalshi series / 241 rows in 40s.

3. **`pages/api/markets.js`** — what the frontend polls (every 60s). Calls the `get_pairs(sport_tags)` Postgres RPC, which joins `markets` and `pairs` in SQL (chained Supabase JS-client filters were silently failing, hence the raw RPC). Filters stale/expired-date rows and prices outside 0.05–0.95, then shapes for the UI.

`pages/index.js` is a single-file client (category tabs, sort controls, market cards, arb badges) with inline styles — no CSS framework. **One card per Kalshi market, with a leg per Polymarket venue** — see "One card, N venues" below. Arb logic lives in the API now, not the client — see "Executable pricing". The client only reads `market.arb` and keeps the spread ≤ 15 points guard (wider spreads are data errors, not arbitrage — see the Polymarket outcome-price bug).

### Automation

Both jobs run from GitHub Actions, not Vercel cron: the Hobby plan caps
crons at once per *day*, which is not a fix for stale prices. The repo is
public, so Actions minutes are free and unmetered.

- `.github/workflows/refresh-prices.yml` — `/api/refresh`. The cron says
  `*/15` but **GitHub does not honour that**: measured gaps between
  scheduled runs on this repo were 45 minutes to 3.5 hours. High-frequency
  schedules on public repos are throttled hard, so treat stored prices as
  up to a few hours old, not what the schedule says. Kalshi rate-limits
  datacenter IPs, so the per-series fetches run at bounded concurrency
  with retry and `kalshiSeriesFailed` **names** the series — a throttled
  one used to return `{ markets: [] }`, read as a series with nothing
  open, and freeze its rows indefinitely while every counter reported
  success.
- `.github/workflows/match-markets.yml` — **non-sports matching, off
  Vercel**. Politics stopped fitting the 300s ceiling once Kalshi's
  Elections category landed: 12,210 Kalshi rows against 5,458
  Polymarket ones is 66M cosine similarities on 1024-dimension vectors,
  and the JS matcher and the pgvector one both returned **no body at
  all** after 4m40s. A GitHub runner has no such ceiling.

  `lib/matcher.js` is imported by both the route and
  `scripts/match-category.mjs`, so the two cannot drift — the same
  reason `matchNonSportsMarkets` was already shared between `matchonly`
  and normal mode. Needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` as
  **repository secrets** (the repo is public).

  **A blocking index was tried first and rejected on measurement**:
  scoring only pairs that share a content word lost **55 of 208
  known-correct pairs**, because Kalshi says "SOL" where Polymarket says
  "Solana" and "**real GDP**" where it says "US GDP Growth". Those
  vocabularies not lining up is the whole reason this project matches on
  embeddings, so blocking cannot be made safe here. Don't retry it.

- `.github/workflows/discover-markets.yml` — **two stages per category**,
  daily, sequential with a pause: `?fetchonly=1` then `?matchonly=1`.
  Categories: `mlb nba nhl soccer econ crypto politics`.

  Politics cannot do fetch + embed + match inside Vercel's 300s ceiling —
  matching that category alone takes over two minutes and the combined
  run returned **no body at all**, so the category could not be rebuilt.
  The two halves read different things (the venues, then Supabase), so
  they split cleanly. The fetch stage is re-runnable on its own:
  embedding is capped per call and `embedRemaining` reports what is
  left, so a category with thousands of changed titles converges over
  repeated runs instead of dying.

Both fail the run loudly on non-JSON, an `error` field, or zero rows
updated — **per venue**, since a combined check let `polyUpdated: 0`
ride along on a healthy Kalshi count with a green tick on every run. The
original stale-price bug survived for weeks precisely because a silent
no-op looked like success, and three more variants of it were found in
this one job.

`lib/cronAuth.js` gates both endpoints behind an optional `CRON_SECRET`
(permissive until the var is set on Vercel *and* as a repo secret).

### The refresh poll list, and the two bugs that froze politics

**Measured 2026-09-03: the Kalshi side of politics was 8.3 HOURS stale
while sports, crypto and econ were 77 SECONDS fresh** — and the job
reported `kalshiUpdated: 1743`, `kalshiSeriesFailed: []` and an empty
unpolled list on the same run. 186 of 278 displayed politics cards were
frozen. Two independent causes, both in `/api/refresh`:

1. **`seriesOf()` returned null for anything not starting with `KX`.**
   Kalshi's newer series carry the prefix and **its older ones do not**:
   `HOUSENH1`, `SENATEAR`, `GOVPARTYOR`, `CONTROLS`, `RSENATESEATS` and
   74 more are live, paired and rendered. Every one derived to null, so
   none was ever added to the poll list and none could ever refresh.
   The rule now lives in `lib/kalshiTicker.js`, shared with
   `lib/embedGate.js` — leading capital plus a dash, which still returns
   null for Polymarket's numeric ids. `scripts/kalshi-ticker.test.mjs`
   pins both directions.

2. **A series is not one page.** `KXHOUSERACE` lists **706 open
   markets**; the fetch asked for `limit=200` and read the first page,
   so 506 paired rows could never refresh however often the job ran.
   It now follows the cursor, capped at `KALSHI_MAX_PAGES` and
   **reporting** which series paged and which hit the cap.

**The alarm for exactly this could not report it.**
`kalshiSeriesUnpolled` is documented above as the counter that must stay
empty. It was `[null]` — because every non-KX ticker mapped to the SAME
null and a `Set` collapsed 79 distinct frozen series into one entry,
which reads as a stray rather than as a category-wide outage. Underivable
tickers are now reported separately, **as tickers**, since there is no
series name to report. A diagnostic that folds N failures into one value
is the same class of bug as one that cannot be non-empty.

Note the shape: every counter was green, and the only thing that
revealed it was comparing `priceAgeSeconds` per category against the
others. **Check freshness per category, not in aggregate** — an average
over four categories hid an 8-hour outage in one of them.

**Fixed, measured 2026-09-03**: series polled 124 -> **233**, Kalshi rows
updated 1,743 -> **2,610**, paired-but-missed 225 -> **44**, and the
stale politics cards went **186 -> 0**. Median Kalshi age is now ~47s on
every category. A full run takes **67s** against the 300s ceiling.

**Widening the poll list drew rate limiting**: the first run at 233
series took 16 straight `HTTP 429`s, and three retries 400ms apart is
not a retry against a throttle — it is three more requests into it.
A 429 now honours `Retry-After` and backs off 1.5/3/6/12s over five
attempts, because a series that exhausts its tries freezes until the
next run, which is 45 minutes to 3.5 hours away.

### Price freshness

Three layers, because the scheduled job alone cannot deliver what a
reader expects from a prices page:

1. **GitHub Actions** — the floor. Asks for `*/5`, gets 45 minutes to
   3.5 hours. Runs whether or not anyone is looking.
2. **On-demand** — `/api/refresh?ifStale=<seconds>`. The page asks for a
   read when what it is showing is over `ON_DEMAND_AFTER_SECONDS` (180)
   old. The person with the page open is the one for whom fresh prices
   matter, so their visit is what triggers the work.
3. The **↻ button** passes `ifStale=0` and always reads the venues. It
   used to re-read the database and return instantly, which looks like a
   working refresh button and is not one.

**The cooldown is server-side**, and is a one-row `updated_at` read
rather than a timer — serverless invocations share no state to keep a
timer in. A hundred open tabs produce one venue fetch. A *failed*
freshness read falls through and refreshes: skipping on error would turn
a Supabase blip into "prices are fine", which is the failure mode this
whole area exists to stop.

On-demand failure is silent by design. If `CRON_SECRET` is ever set, the
browser's call starts 401ing and the page must keep working exactly as
before, just with older numbers.

**To get a real interval**: point an external cron (cron-job.org is
free and goes to every minute) at `/api/refresh`, or move to Vercel Pro,
whose crons have a 1-minute minimum against Hobby's once-per-day. The
binding constraint on Hobby is **Active CPU: 4 CPU-hours/month
included** — a ~10s refresh every minute is ~43k runs and blows through
it; every 5 minutes is ~8.6k runs and fits. Supabase's 5GB egress is the
next ceiling after that.

### Search (`/api/search`)

The grid answers "what did we find". Search answers "what about this
one", which is the question a reader arrives with. `markets` holds
~23,000 rows and `pairs` covers about a thousand, so before this ~96%
of the catalogue was invisible.

Returns **one result per claim**: a matched set is one result carrying
its venues, an unmatched market is one result on its own. "Only on
Kalshi" is an answer, not a failure.

- **Discovery, not execution pricing.** The arb figures stay in
  `/api/markets` with the fee maths and the live depth re-check. A
  second copy here would be a second place for them to drift, and a
  midpoint gap rendered beside a price reads as an edge when it is not
  one — midpoints said 98.5c on a pair that executes at 101.1c.
- **One query per platform.** Volume is contracts on Kalshi, dollars on
  polymarket.com and absent on polymarket.us, so a single query ordered
  by volume ranks contracts against dollars. Volume orders within a
  platform; relevance orders between them.
- **Ranking is matched-and-live first, not best text match.** A prefix
  match is a weaker signal than the site's whole purpose: "bitcoin" put
  four settled "Bitcoin all time high by <past date>?" markets, quoted
  at zero, above all 12 matched pairs. Settled markets rank last rather
  than being hidden — being told a market is finished beats being told
  nothing.
- Never `select=*` (the ~20KB embedding), and pairs are read from both
  directions, chunked at 200 ids.

**Search is also the review queue.** What people look up and find
unmatched is a demand signal for the matcher. Two found immediately:
"fed rate" returns 8 markets and 0 matched, and "government shutdown"
returns 9 across both venues with 0 matched.

### Embedding is gated per Kalshi series

`lib/embedGate.js`, imported by `embed.js`. Kalshi's econ catalogue is
14,760 markets against Polymarket's **342**, so at most 342 Kalshi rows
can ever be paired and the rest are vectors bought to be compared
against nothing. Each costs a flat **~4KB** of pgvector — float arrays
are high-entropy, so TOAST compresses them to nothing.

**The rule is evidence, not taxonomy.** A series is embedded in full the
first time it is seen; after that only if it has actually produced a
pair. A series that had its chance and matched nothing stops consuming
quota as it lists new strikes and periods.

- **Taxonomy was tried first and is wrong.** Excluding Kalshi's
  Financials category looks obvious — 10,772 markets of S&P, Treasury,
  Nasdaq and FX ladders — but `KXIPOOPENAI` and `KXIPOANTHROPIC` are in
  Financials too and are **4 of the 21 econ pairs the site shows**. The
  waste is also a long tail: ~1,050 series of roughly ten markets each,
  one per listed company, which no hand-written list can track.
- **Skipping is not deleting.** An already-embedded row keeps its
  vector, and the market is still fetched, stored and searchable —
  search reads titles, so nothing leaves the catalogue. The series
  simply stops being a match candidate.
- **Polymarket is never gated.** It is the scarce side every pair is
  built against, and its ids carry no series anyway.
- **A first chance is the FULL series, not a sample.** Sampling risks
  missing the one strike in a ladder that has a counterpart, which is
  the loss this gate exists to avoid trading storage for.
- **`?reprobe=1` re-opens everything for one run.** That is the way back
  in when Polymarket adds coverage for something Kalshi already lists.
  `force=1` bypasses the gate too.
- The gate applies to **every non-sports category**, not just econ —
  politics and crypto have the same shape of waste.
- `embedGate` in the response and the workflow log **names** the skipped
  series rather than only counting them, so a series that ought to be
  matching is recognisable instead of hiding inside a total.
  `scripts/embed-gate.test.mjs` pins the cases.

**Measured storage reality (2026-09-01):** `embedding_v` alone is
**147MB across 37,518 rows** — 4.01KB each, confirming vectors do not
compress. That is 3.3x the ~11,300 embedded rows this file used to
claim. Migration 0007 is **already applied**, and it is
**non-destructive**: `embedding` (JSON) and `embedding_v` (vector) are
both stored, so it *added* a second copy rather than replacing the
first. The 5x win only lands when the JSON column is dropped, and that
is blocked — `lib/matcher.js` reads `m.embedding` and is the live
matching path for both the route and the Actions workflow. Dropping it
today stops every non-sports category from matching.

### The discovery job, and why it took 280 seconds

The daily run failed outright on 2026-09-04: politics returned
`curl: (28) Operation timed out after 280002 ms with 0 bytes received`,
and prune answered `canceling statement due to statement timeout`.
Every counter in the response was healthy, because **none of them
measured time**. `timingsMs` in the fetchonly response exists so the
next one is a reading rather than a theory.

**Verified 2026-09-05** on a `soccer nfl ncaaf politics` run plus
prune: the whole job took **5m31s**, politics fetch **86-109s** against
the 280s that used to time out, prune scanned **106,729 rows in 38s**,
soccer upserted **0** (`poly dropped (no Kalshi side): soccer=9660`),
and ncaaf wrote **317 pairs**. Politics splits as roughly
`venueFetch=16-27s shape=27-57s marketsUpsert=28-35s embed=15-21s` —
nothing near the ceiling, on a complete sweep.

**The store seed converges over runs, not in one.** Measured across
three: `99 -> 180 -> 331` series read from the store. Every lookup
succeeds — `seriesMeta status: ok=386`, no 404s and no throttling —
so the slow climb is not failures being retried. **Do not theorise
from the split alone**: the counter was assigned rather than summed,
and politics calls the attach twice (Politics and Elections are two
Kalshi categories), so the reported `fetched` was one category's while
`status` counted both. A run reporting `368 fetched` beside `386 ok`
is that bug, not a fact about Kalshi.

Three independent causes, all fixed:

1. **2,298 HTTP calls for facts we already had.** `series_slug` and
   `fee_multiplier` are per-SERIES and change roughly never, but the
   cache is module-scoped and a serverless invocation handles one
   request — so politics re-asked `/series/<ticker>` for all 2,298 of
   its series on every run, against an API that rate-limits datacenter
   IPs, and fired them through an unbounded `Promise.all`. It is now
   bounded at `SERIES_META_CONCURRENCY = 8` **and** seeded from
   `storedSeriesMeta()`, one paged select of three narrow columns.
   Keyed on a **non-null** slug, so a series we asked about and got
   nothing for is retried rather than cached as absent.
   `seriesMeta: { series, fromStore, fetched }` reports the split.

2. **Soccer ingested 9,646 Polymarket rows per run for ZERO pairs.**
   `KXWCGAME` is the only soccer series wired up and has no open
   markets; the leagues that do (`KXMLSGAME`, `KXEPLGAME`,
   `KXLALIGAGAME`, `KXSERIEAGAME`) are three-way and unmatched by the
   two-team join. A fifth of the catalogue was paying storage against a
   Kalshi side that does not exist. A sports tag whose Kalshi side comes
   back empty is now not stored at all.

   **The rule is general, not a soccer special case** — NHL out of
   season costs nothing either, and both resume on their own the day
   Kalshi lists a game. It is safe *here* and would be wrong for the
   non-sports categories: sports match by an exact join on the game
   identifier, so a Polymarket row with no Kalshi counterpart is a
   candidate for nothing, whereas in econ/crypto/politics the unpaired
   rows **are** the pool the embedding matcher draws from.

   **Skipping is not deleting.** Rows already stored keep their titles
   and stay searchable; they simply stop having `updated_at` refreshed,
   so `/api/prune` reclaims them on the existing "not seen in 14 days"
   rule. This route deletes nothing.

   `polyFetched` and `polyDroppedNoKalshiSide` are reported beside
   `totalPoly`, because a counter that quietly shrinks teaches you to
   distrust it.

3. **`pageAll` in prune was OFFSET paging.** `.range(from, from+size)`
   is LIMIT/OFFSET, and an OFFSET makes Postgres scan and discard every
   row before the window — so paging a 63,000-row table costs O(n²) and
   the LAST pages are the slowest. That is why the read worked for
   months and then began timing out: the table grew past what the final
   offsets could do inside the limit. Keyset paging (`order(key)` +
   `gt(key, last)`) reads each page from an index seek, so page 60
   costs what page 1 costs. Halving on error is kept — it is for
   payload-size failures, which are a different thing.

   `fetchAllRows` in `embed.js` still pages by OFFSET. It is the same
   latent bug and has not bitten yet only because its reads are
   narrower.

4. **College football was matched by neither workflow.**
   `discover-markets.yml` ran its sports match stage for
   `mlb nfl nba nhl soccer` and `match-markets.yml` runs
   `politics econ crypto`, so `ncaaf` fell through the gap between the
   two lists. Its pairs were written by hand when the league was wired
   up and nothing had rebuilt them since — on a weekly slate that means
   the stored pairs decay into finished games while each new fixture
   never joins. Found only by reading the workflow to add logging, not
   by any counter.

### Nothing pays Voyage twice for the same row

Embeddings are the only thing this project pays PER ROW for, and the
decision to spend rode entirely on one big unscoped read. When that read
silently truncated at its row cap, every market past it looked
never-embedded and was bought **again, every run** — politics spent
1,200 embeddings a run on rows it already had and reported
`embedded: 1200` as if that were work.

Three guards, in the order they fire:

1. **A pre-spend confirmation.** Immediately before the Voyage call,
   re-ask about exactly the rows about to be paid for: one chunked
   select of two narrow columns over at most `embedLimit` ids. It is
   scoped BY ID, so it cannot be truncated by the kind of cap it exists
   to catch. It is deliberately a **second opinion**, not a
   replacement — `needsEmbedding` still does the work, and a
   disagreement between the two is the alarm.

   **A failed check must not suppress the work.** Treating a Supabase
   error as "already embedded" would silently stop embedding on any
   hiccup, which is worse than paying twice, so it falls through and
   spends.

2. **`embedSpend: { asked, embedded, alreadyEmbedded }`.**
   `alreadyEmbedded` is **0 in steady state**; anything else means
   `needsEmbedding` is reading a stale or truncated set. The workflow
   treats it as an **error**, not a note — the bug it catches ran for
   months while reporting itself as work done.

3. **`fetchAllRows` reports a cap hit ALWAYS**, not only when a caller
   passed an `errors` array — the read that decided the spend did not
   pass one, which is exactly why its truncation was invisible.
   `truncatedReads` collects them per request from every call site and
   fails the run. A silent cap is not a smaller answer, it is a wrong
   one.

**The guard caught a real bug on its first run, and it was not the cap.**
Crypto came back `asked=1200 embedded=1190 alreadyEmbedded=10` with no
truncation reported. `fetchAllRows` paged with `.range()` and **no
`ORDER BY` at all** — Postgres promises nothing about row order without
one and may return a different order for the same query, so consecutive
pages could overlap or **skip rows outright**. A skipped row reads as
never-embedded and is bought again.

It is keyset now (`order(key)` + `gt(key, last)`), which fixes that and
the O(n²) OFFSET cost in the same change; `scripts/page-all.test.mjs`
pins it against a deliberately unstable backend and fails seven ways
against the old pager. The `pairs` read selects `id` purely to give the
pager a key.

`fetchAllRows` was the last OFFSET pager on a live path. One remains, in
`match_candidates` — opt-in behind `?matcher=sql` and off by default —
and it reads an RPC whose ordering has not been checked.

**Then it caught a second one, in the fix itself.** Econ came back
`asked=76 embedded=3 alreadyEmbedded=73`. The pre-filter read was scoped
by `sport_tag` and the confirmation by id, so the two disagreed for
every market **stored under one category and fetched under another** —
Kalshi files its crypto series under Financials, which the econ run
sweeps, so rows stored as `crypto` read as never-embedded under `econ`.

**An embedding belongs to an (id, title); the row's category has nothing
to do with whether its vector is valid.** The scoping was a fix aimed at
the wrong thing: the original bug was a SILENT TRUNCATION, and the cure
for that is to stop truncating and to say so when it happens, not to
read less and hope. The read is unscoped again, keyset-paged, capped
above the whole catalogue, and loud if it ever reaches the cap.

Worth keeping as a shape: that defect would have re-fired **every run
forever** while costing nothing, because the confirmation was already
stopping the spend. A daily alarm nobody can clear is the same failure
as a counter that can only be non-zero — it teaches you to ignore it.

`force=1` skips the confirmation, because re-embedding everything is
what it is for.

### Soccer: the two venues barely list the same games

**Measured 2026-09-05, and it decides the question.** Kalshi lists 135
open soccer games across five leagues — `KXMLSGAME` 144 markets,
`KXLALIGAGAME` 90, `KXSERIEAGAME` 63, `KXEPLGAME` 54, `KXUCLGAME` 54.
Polymarket lists 116 game-shaped soccer events across **39 leagues that
are almost entirely different ones**: Azerbaijan, Bolivia, Georgia,
Latvia, Kazakhstan, Chile, Colombia, Slovakia, Romania.

**The exact join produces 6 pairs. All MLS, all on one date.**

- Polymarket has **no EPL, La Liga, Serie A or UCL games at all**. There
  is no Premier League tag on the exchange; `Serie A` (100618) and
  `Champions League` (1234) hold futures and outrights, not fixtures.
- Its MLS coverage is 17 games on **4 dates, three of them back in
  April**. That is a coverage gap, not a listing horizon — the one
  shared date has Kalshi at 14 games and Polymarket at 6.

So the three-way matcher is **not worth building yet**, and the reason
is not the matcher. Both venues model a soccer game the same way — one
Yes/No market per outcome, home/draw/away — so the work is
straightforward; there is simply almost nothing to join. Wiring
`KXMLSGAME` in would also **re-enable ingesting ~10,000 Polymarket
soccer rows**, since the Kalshi side would stop being empty, to win six
pairs that expire the same night.

Re-measure before building: this is a fact about Polymarket's current
coverage, not about the leagues.

### NHL has no Kalshi side to check against yet

`KXNHLGAME` returns **zero markets in every status** — open, unopened,
closed and settled — so the season is not listed at all. Polymarket
already lists **80 games, 2026-09-19 to 2026-10-02**.

That means the team-code vocabulary **cannot be verified in advance**,
and Polymarket's NHL codes are not the standard ones: `cal`, `mon`,
`las`, `nj`, `sj`, `tb`, `utah` where the league writes CGY, MTL, VGK,
NJD, SJS, TBL, UTA. `TEAM_CODE_ALIASES` is flat across leagues, so
these have to be checked against the existing entries when Kalshi does
list, not just against hockey.

Nothing to build until then — but the day it lists, a mismatch would
produce **zero pairs with every counter healthy**, which is the exact
failure that hid the MLB title-format change. So the workflow now fails
when **both venues keyed games and none joined**. Guarded on `polyKeyed`
too, so a league Kalshi lists and Polymarket does not — soccer today —
stays quiet rather than going red every day for a real absence.

### Retention

`/api/prune` (`?dry=1`, `?days=`) deletes rows from `markets` that
neither venue lists any more. Runs from `discover-markets.yml` **after**
the category loop — discovery is what refreshes `updated_at`, so running
it first is what makes "not seen in N days" mean *delisted* rather than
*not fetched yet*.

- **Never deletes a row referenced by `pairs`**, and refuses to run at
  all if the pairs read fails rather than pruning from a partial
  protection set.
- **14 days, chosen from the data**: at 21 days nothing qualified, at 14
  exactly 872 rows did — the finished MLB fixtures. First real run
  deleted those 872 of 23,342 with 144 protected and every tab unchanged.
- Sports fixtures go by the same "not seen" rule, *not* by game date:
  Kalshi keeps a game listed while it settles, and deleting mid-settlement
  would drop a row `pairs` may still point at.
- Reads without `embedding` (that is the read that was failing on payload
  size) and deletes in chunks of 200, per the `.in()` URL-length lesson.

**It prunes row count AND the one column nothing can read.**
`resolution` holds Kalshi's `rules_primary` and is stored for every
market, but the only path to it is `get_pairs`, which JOINS `pairs` — so
a row outside `pairs` carries text nobody can reach. 55,355 rows carry
it where roughly 2,000 can display it. Prune nulls it for unpaired rows,
**after** the delete so it never touches a row that just went, and
discovery rewrites it for anything that becomes paired, so it is
self-healing rather than lossy.

**Nulling a TOASTed value does not shrink the database.** It marks the
space reusable by the table; the reported size falls only on a rewrite
(`VACUUM FULL`, which takes an exclusive lock and needs free disk about
equal to the table). What this stops is the GROWTH. Dropping an INDEX,
by contrast, returns its space immediately.

### Measured storage

**Resolved, 2026-09-02: `markets` is 301MB.** It was 776MB. The project
is on Supabase Pro (8GB included), so storage is no longer a constraint
— this section is kept as the record of what the cleanup consisted of,
not as an open problem.

What got it there, in order: `0014` dropped 114MB of never-scanned HNSW
indexes (immediate), prune nulled ~168MB of unreadable `resolution`
text, `0015` dropped the 266MB JSON `embedding` column, and a
`vacuum (full, analyze) markets` over a direct connection rewrote the
table to actually return the space. The catalogue GREW from 55,355 to
63,239 rows across the same period, so it now holds 14% more markets in
39% of the space.

**The vacuum reported `Failed to fetch (api.supabase.com)` and had
nevertheless completed.** The editor's request timed out; the statement
did not. Only a rewrite can take the table from 776MB to 301MB, so the
size is the evidence — do not re-run a `VACUUM FULL` on the strength of
an error message alone, because a needless one costs an exclusive lock
and several minutes of downtime.

### What the numbers were, 2026-09-01

The free tier is 500MB. The database was **800MB**.

| | size |
|---|---|
| `markets` TOAST | 581MB |
| `markets` indexes | 121MB |
| `markets` heap | 74MB |

Inside TOAST: `embedding` (JSON) **266MB**, `embedding_v` (vector)
**147MB**, and ~168MB of `resolution`.

**The three HNSW vector indexes had `idx_scan: 0`** — 114MB of the
121MB, never scanned, because `match_candidates()` is opt-in behind
`?matcher=sql` and stays off on performance. Migration `0014` drops
them; `0007` recreates them and is the way back.

**Migration 0007 is applied and is NON-DESTRUCTIVE**: it *added*
`embedding_v` rather than replacing `embedding`, which is why the
database grew when it was meant to shrink. Migration `0015` drops the
JSON column; `0014` drops the unused HNSW indexes.

**Everything reads `embedding_v` now** — `lib/matcher.js`,
`scripts/match-category.mjs` and every select in `embed.js` — and
`embed.js` writes only the vector. The two columns serialise
identically: pgvector renders `[0.1,0.2,...]`, exactly what
`JSON.stringify` produced, so the cutover was a column rename and a
shared `parseVector()`. That helper returns null rather than throwing,
because it runs inside the loop over every stored row and
`JSON.parse("")` would otherwise cost a whole category its run.

**Float4 carries less precision than the float64 JSON did, and
borderline candidates CAN move.** Verified on identical production
inputs: econ came back byte-identical at 34 pairs, crypto went 29 -> 30,
losing nothing and gaining one correct pair (Kalshi's
`above $109,999.99 by Dec 31 2026` against Polymarket's
`reach $110,000 by December 31 2026`). One moved in, none moved out — a
future run could move one the other way, and the GATES rather than the
score are what should catch that.

**`drop column` does not reclaim the space.** It marks the attribute
dropped without rewriting the table, so the TOAST entries stay and the
reported size does not fall. `vacuum (full, analyze) markets` returns
it, takes an ACCESS EXCLUSIVE lock for its duration, and needs free disk
about equal to the table.

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

**Three counters, and only one of them is an alarm.** The job polls
whole Kalshi *series*, and a series carries every strike and period
Kalshi lists while `markets` holds only what discovery kept — so
`kalshiNotStored` (418 of 995 fetched) is expected and large, not a
drop. `kalshiPairedMissed` names paired markets whose series was polled
and which Kalshi still did not return: settled fixtures and finalized
long shots, also expected — its first run reported 9, all of them MLB
games played the day before plus two `status: finalized` crypto
markets. **`kalshiSeriesUnpolled` is the one that must stay empty**: a
series a paired ticker points at that the job never polls means those
prices freeze forever with nothing to say so, which is exactly the
hand-maintained `KALSHI_SERIES` bug this job was rewritten to remove.

A counter that can only ever be non-zero teaches you to ignore it, which
is why the first version of this — a single "paired but not refreshed"
number — was worse than useless.

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
- `strikePresenceCompatible(a, b, titleA, titleB)` — a market that names a strike and one that does not are not the same claim. This is what finally killed the "positive return in 2026" family, which carries no threshold, deadline or unit and so passed every other gate. **The guard matters more than the rule**: absence of a *parsed* claim is not absence of a claim, so it only rejects when the bare title states no value at all (years, **quarters and calendar dates** excluded — stripping only years left "Q3" and "December 31" reading as stated thresholds, which waved six GDP thresholds through against one strikeless "US GDP Growth in Q3 2026?"). A first version of this returned the side already known to be null and therefore always rejected — it cost a labeled case, and only the eval caught it.
- `rankingCompatible(a, b)` — a superlative on exactly one side (best, worst, highest, lowest, top, most, all-time high). "Positive return in 2026" against "best performance in 2026" scored 0.896: one asks whether an asset clears zero, the other whether it beats every other. Neither states a strike, so claim asymmetry cannot separate them.
- - `econMetrics(title)` / metric sets — what the market actually
  measures (gdp, gdp_nominal, inflation, fed_rate, regime,
  unemployment, recession, net_worth, debt, equities, tariff). Every
  other gate reads a number, a period or a deadline, so two econ
  markets stating none of those are separated by nothing:
  "State of the economy — Soft landing" against "Fed Rate Hike in
  2026?" scored 0.794. Compared as sets, rejecting only on
  **disjointness**, so a title naming both metrics or naming none
  blocks nothing. `gdp_nominal` drops the generic `gdp` tag, because
  "current-dollar gross domestic product" matches both patterns and
  the sets would otherwise still intersect — nominal ran ~2 points
  above real through 2026, which is exactly the gap that renders as
  free money.
- **Touch vs terminal.** Kalshi runs both shapes on the same coin,
  strike and date: `KXBTCMAX150` resolves if the price is above the
  strike at ANY POINT before the date; `KXBTCY` resolves on the average
  of the sixty seconds before 12 AM EST, AT that moment. A touch market
  is always at least as likely to resolve Yes, so pairing the two
  manufactures an edge. Read from the VERB — "reach", "hit", "above … by"
  describe a window whatever date follows — because Kalshi states a
  window's end as a moment ("above $6.00 by 11:59 PM ET **on** Dec 31,
  2026") and letting the moment decide called five correct XRP pairs
  terminal.
- **A missing year does not make the month unreadable.** Polymarket US
  drops years constantly ("Elon Musk Net Worth on August 31?").
  Rejecting every bare date would have killed four correct December
  pairs along with the August one; comparing month and day separates
  them. The comparison is circular over the year so Dec 31 and Jan 1
  read as one day apart.
- **Direction on counted changes.** "Exactly 1 cut" and "1 Fed rate
  hike" share unit `count` and value 1 and are opposite bets. `dir` is
  a separate field, not part of the unit, so a title whose direction
  cannot be read still compares on unit and value.
- **Kalshi's bucket labels put the number first** — `6.1% or Above`,
  `0.0% or Below`, `2.6% to 3.0%`. Every comparator-first pattern
  missed them and they parsed to nothing at all. Ranges compare with
  one tick of slack on the **low** edge only: Kalshi labels a bucket by
  its first included value where Polymarket writes the boundary, so
  1.1–1.5 and 1.0–1.5 are the same bucket while 2.6–3.0 and 2.0–2.5
  are not.
- **Thresholds spelled out in words** — "hit zero", "negative growth".
  Teaching the extractor one side of such a pair without the other
  turns a correct match into an asymmetry rejection, which is how
  `0.0% or Below` ↔ `Negative GDP growth` nearly died.

`scalarSignaturesCompatible(a, b, sportTag)` combines them. **Reject only when both sides have an extractable signature and it disagrees** — anything unrecognized falls through to embedding score alone, so the extractors don't need to understand every phrasing to be useful. The deadline rules above are the deliberate exception: absence of a *resolvable* year, where a year is clearly being stated, is itself information.

Matching is **globally greedy**: build all gate-passing `(kalshi, poly, score)` candidates, sort by score descending, then assign. Assigning per-Kalshi-row in DB order (the old way) meant whichever row was processed first claimed a contested Polymarket market, not the best-scoring one.

`matchNonSportsMarkets()` is shared by both `matchonly` and normal mode. They were separately duplicated for a while and drifted (a diagnostic added to one branch, missing in the other) — keep them unified.

## Sports matching (an exact join, not a text match)

Sports does **not** use embeddings or similarity. Both venues publish
the game as structured identifiers, so matching is a join on
`{date, unordered pair of team codes}`:

```
Kalshi ticker  KXMLBGAME-26AUG271910MILNYM-NYM
                          ^date    ^teams ^side
Poly    slug   mlb-mil-nym-2026-08-27
```

Helpers live in **`lib/sportsKeys.js`**, imported by both `embed.js`
(which builds the pairs) and `markets.js` (which prices them). They must
agree on the team-code vocabulary — a divergent copy would pair a game
correctly and then price the wrong half of it.

- The Kalshi side suffix (`-NYM`) is what makes the concatenated team
  blob splittable: `MILNYM` minus `NYM` leaves `MIL`. There is no other
  unambiguous split point between two variable-length codes.
- `TEAM_CODE_ALIASES` maps Kalshi codes to Polymarket's, and is
  deliberately codes rather than names. Diffing all 32 NFL codes on both
  venues turned up exactly two disagreements, same as MLB's two — the
  venues agree on nearly everything, which is why this replaced a
  30-entry full-name map per league.
  **The Los Angeles pair is a trap**: Polymarket writes the Rams as
  `LA` but the Chargers as `LAC`, so `LAR→LA` while `LAC` needs no
  alias. One rule for "both LA teams" pairs the wrong club and prices
  the wrong half of the game.
  The map is flat across leagues, so a new league's codes have to be
  checked against the existing entries, not just against its own venue.
- **`polyOutcomeIndex()` decides which Polymarket price belongs to a
  Kalshi side.** Slug order matches `outcomes` order on every 2026
  fixture Polymarket lists (45/45), so it is a lookup. Do not go back to
  keyword-matching the side label: `"A's"` has no token longer than two
  characters, so it matched nothing and fell through to outcome 0 — the
  *opponent's* price — and `"New York M"` matches "New York Yankees" as
  readily as "New York Mets". Both render a large fake arbitrage.
- Games whose date has passed are skipped at match time.
- A market with no parseable key cannot join. That closes the hole where
  a Polymarket futures market (`mlb-world-series-champion-2026`, no date
  in the slug) matched a single game, because the old `datesCompatible()`
  read a missing date as permission to pair.
- Kalshi titles its game markets from one side ("San Francisco wins"),
  so the display title is rebuilt from `rules_primary`, which states the
  matchup and date in full. Matching does not depend on this.

**Why it was rewritten:** Kalshi changed its wording from
`"Cincinnati vs Chicago WS Winner? — Chicago WS"` to
`"San Francisco wins"`, the title regex returned null for all 74 open
MLB markets, and every one was skipped. Only stale rows still in
`markets` parsed, so a discovery run reported 66 new pairs of which 61
were games played two weeks earlier — and reported success throughout.
`matchDiagnostics.kalshiKeyFailures` exists so the next format change is
loud instead of silent.

### College football keys on NAMES, because its codes cannot be trusted

`KXNCAAFGAME` is **250 open games** against MLB's 106, and the biggest
sports addition available. It does not fit the code-based join:

- **178 of 275 Kalshi codes disagree with Polymarket's.** That is an
  alias map two orders of magnitude past MLB's two entries, and it
  would rot every time either venue renamed a school.
- **Kalshi REUSES three codes for different schools** — `CSU` is both
  Colorado St. and Central State (OH), `KSU` is Kansas St. and Kentucky
  State, `WEB` is Weber St. and Webber International. A flat map cannot
  say "KSU means Kansas State here and Kentucky State there", so it
  would key two fixtures to one game and pair the wrong teams.

Both venues publish clean **names** — Kalshi's `yes_sub_title`,
Polymarket's `teams[].alias` and its moneyline `outcomes` — and names
are unique on both sides (Polymarket reuses no code at all). So
`NAME_KEYED_LEAGUES` keys these on the normalised name and needs no
alias table.

- A single Kalshi market names only **its own** side, so the two sides
  are regrouped by event (`kalshiEventOf`) before a two-name key exists.
- **CFB slugs carry digits in the code** (`cfb-lcdbfc25-nwst-2026-08-27`),
  which the letters-only pattern in `polyGameKey` rejects outright —
  hence `polyGameDate`, which reads the date without the codes.
- `outcomeIndexByName` resolves which Polymarket outcome a Kalshi side
  refers to. On this league it is a lookup, where the keyword fallback
  would be a guess.

**Measured against the live slate: 219 of 250 games join, 0 key
failures, and all 219 outcome indexes resolve.** The 31 that do not
join are Kalshi carrying a mascot ("Central Washington Wildcats")
where Polymarket has the school ("Central Washington"), plus games
Polymarket does not list. **Prefix matching would recover some and is
NOT safe**: "michigan state" starts with "michigan".

**polymarket.us DOES list CFB, and two bugs hid it.** `.us` names the
league **`cfb`** where our sport tag says `ncaaf`, so the slug builder
produced `aec-ncaaf-…`, every one of which 404s. And
`fetchPolymarketUsGames` was entirely code-keyed, so a name-keyed
league could not name a game to ask for. `usLeagueFor()` maps the token
and the US fetch now takes the name-keyed path.

**Test the gateway with `?slug=`, not a path segment.** A market is
`/v1/markets?slug=<slug>`; `/v1/markets/<slug>` returns 404 for
*everything*, including slugs the site renders. That false negative is
what produced the claim above, and a control — a known-good MLB slug —
is what caught it. Never conclude "not listed" from a probe that has
not been run against something known to exist.

**The live tag is `100351`, not `636`.** `636` ("college football") is a
2025 archive — 53 events, all closed but one futures market — and
reading it is how this league was first, wrongly, written off as
unlisted by Polymarket. `scripts/sports-keys.test.mjs` pins the three
collisions and the near-misses a fuzzy matcher paired wrongly.

### Prime-time games date a day apart on the two venues

**Kalshi dates a game by its US EASTERN date; Polymarket dates the same
game by its UTC one.** An afternoon kickoff agrees. A 8:15pm ET kickoff
is 00:15 UTC the NEXT DAY, so Thursday Night, Sunday Night and Monday
Night Football were unjoinable as a class — measured on the live slate,
**7 of 32 NFL games**, every one +1 day, every one with a UTC kickoff
between 00:15 and 00:35, while all 25 that joined kick off between
17:00 and 20:25 UTC. They are also the most-watched games of the week.

**Do not "fix the timezone properly" — the measurement says it breaks
MLB.** MLB joins **41 of 41** on the ticker date as it stands. Rebuilding
the key from Kalshi's own `occurrence_datetime` scores 39/41 and from
`close_time - 48h` scores 23/41, so either principled-looking rule
*loses* games that work today. Polymarket's date convention differs per
league — a fact about their sports feeds, not something derivable.

So `WEEKLY_LEAGUES` (nfl, ncaaf) get a **one-day retry**, and the list
is the safety argument: a retry is only sound where a fixture cannot be
adjacent to another meeting of the same two teams. NFL and college
football play once a week; **MLB, NBA and NHL play series on
consecutive days**, where +1 could pair Monday's ticket with Tuesday's
book. `scripts/sports-keys.test.mjs` pins all three exclusions.

Two further guards, both load-bearing:

- **Every exact key is claimed before any retry runs.** Interleaving the
  passes would let an early Kalshi row's retry take the game a later row
  matches exactly.
- **A retry only takes a Polymarket row no exact key wants.**

`joinedNextDay` in `matchDiagnostics` counts them, so a venue changing
convention shows up as a number rather than as a quietly smaller slate.

**Verified in production 2026-09-05.** NFL `joined` went 50 -> **57**
with `joinedNextDay: 7` and an EMPTY `unjoinedKalshiKeys`; the recovered
seven are all on polymarket.com, which took that venue 25 -> 32. MLB
came back `joinedNextDay: 0`, `unjoinedKalshiKeys: []`, 76 pairs — the
retry never fired, which is the guard working rather than the guard
being untested.

### An unscoped read hit the row cap and re-embedded forever

`embedRemaining` for politics went **4233 -> 3692 -> 4384** across three
consecutive runs, spending 1,200 Voyage embeddings each time and
converging on nothing.

The embedded-titles read — the one that decides `needsEmbedding` — had
**no `sport_tag` filter**, so it asked for every embedded row on the
exchange (econ 28,797 + politics 26,239 + crypto 22,684) against
`fetchAllRows`'s `maxRows` of 60,000. Past the cap it returned what it
had **silently**, so every row beyond read as never-embedded, was
re-embedded, and *which* rows fell past it moved with page order — hence
a number that wanders instead of falling.

A category run only ever asks about rows in its own category, so the
other ~50,000 were paid for and never looked up. It is scoped now.

**Hitting the cap is a truncation, not an answer**, and `fetchAllRows`
now says so through the `errors` channel it already had —
`embeddedReadErrors` in the response. A read that cannot distinguish
"the tail does not exist" from "I stopped looking" is the same class as
the `Set` that collapsed 79 frozen series into one null.

**Verified in production 2026-09-05: politics went from 4,384 stuck to
`embedded=79 remaining=0`.** The backlog was never a backlog — it was
the same rows being bought again every run. `embed` fell from 15-21s to
**1.5s**, and the series gate went from holding back ~5,000 rows to
**567**, because it is now reading a set that means what it says.

### Implausible pairs are hidden, not just unflagged

**Two venues do not disagree by 15 points on the same claim.** The
`IMPLAUSIBLE_SPREAD_PTS` guard used to suppress only the arb badge, so
the card still rendered "Kalshi 92% / Polymarket 10%" side by side — and
a reader who sees that concludes the site is broken, which costs more
trust than showing nothing and is the CORRECT conclusion, because the
pair is wrong. `/api/markets` now drops them and counts them under
`hidden.implausibleSpread`, named separately from `longShots` because a
long shot is the product working and this is the matcher failing.

Measured 2026-09-03: **24 of 535 displayed legs** were over the
threshold, 22 of them politics. Every one read by hand was a matching
fault rather than an edge. Four distinct failure modes, three now gated:

- **Negation.** "Zelenskyy and Putin meet before 2027" against "Will
  Zelenskyy and Putin NOT meet before 2027" — 0.908 similar, priced 7%
  against 92%. `hasNegation` uses a SHORT list of inverters; "no" is
  excluded because it is load-bearing in "no more than 3 cuts" and
  would cost a family of correct threshold pairs.
- **Opposing modifiers.** "Red wave in 2026" against "Blue wave in
  2026" — 0.913, priced 6% against 77%. Each side must commit to one
  pole and only one, so a title naming both parties states no
  preference and is not caught.
- **National versus state.** "Democrats win exactly 5 seats in the U.S.
  House" against "House Seats … In Arizona — 5". `statesNamed()`
  already existed and did not catch it: the asymmetry rule rejects only
  on MUTUAL disagreement, and the national side names no state. That
  rule is right nearly everywhere and wrong here — on a title that says
  "U.S." explicitly, naming no state IS the claim.
- **Participant scope** ("Trump meet Putin" against "Trump, Putin AND
  Zelensky meet together") is NOT gated. Every rule that catches it
  also rejects correct pairs where one title omits a name, and the
  display filter catches it anyway.

Some implausible pairs are not text-diagnosable at all — Delcy
Rodríguez "de facto head of state" against "the leader of Venezuela"
reads as the same claim and prices 81 points apart. The gates handle
what the words reveal; the display filter is what makes the rest
invisible to a reader.

### Why a pair is missing is usually latency, not the matcher

`?explain=<kalshiId>` on `/api/embed` scores one Kalshi row against
every Polymarket row in its category and reports the score **and** the
gate verdict per candidate. It writes nothing and reads one row on the
Kalshi side, so it answers in seconds where a full politics `matchonly`
does not fit in Vercel's 300s ceiling at all.

**The first thing it found was that the matcher was right.** Searching
"government shutdown" returned 9 markets and 0 matched;
`KXGOVTSHUTDOWN-26OCT01` against `gsc-usfedgvmt-by-2026-10-01` scores
**0.8836**, passes every gate, and appeared in the very next dry run.
It was simply **not written yet**. Discovery and matching are DAILY, so
a newly listed market waits up to 24 hours to be paired — measured at
**135 politics pairs pending** (882 the matcher would write against 747
stored). Before theorising about a gate, check whether the matcher has
run since the market was ingested.

Two of the four "gaps" sampled this way were the matcher being
**correct**: `recession` is Kalshi's US markets against Polymarket's
Japan and UK ones (the `mentionsNonUsRegion` gate), and `tariff` is
Kalshi's `at least 10%/20%/30%` ladder against Polymarket's "a tariff
increase", which states no threshold (`strikePresenceCompatible`).
**"0 matched" is not evidence of a gap.**

### How someone leaves office is part of the claim

Auditing the pending 882 turned up three wrong pairs of one shape:
Kalshi counts members who **lose** a primary or a re-election where
Polymarket counts members who **retire**. "Exactly 6 House Republicans
lose their primary" was matched against "the number who retire is 44 or
more".

The numeric gate does not save these. It rejects only when BOTH sides
parse, and `be 44 or more?` is a phrasing `extractNumericClaim` does not
read, so two counts a factor of seven apart passed on score alone.
Teaching it that phrasing would help but would not fix this: six
retirements and six primary losses are different markets even when the
number agrees.

`departureModes()` compares them as sets and rejects only on
disjointness, like `econMetrics` — a title naming both modes or naming
none blocks nothing, which keeps it inert on the ordinary "will X win"
races that are most of the category. `lose_primary` drops the generic
`lose_general` tag, or "lose their primary" would match both patterns
and the sets would still intersect.

### Diagnostics convention

Both modes return `matchDiagnostics` with `threshold`, embedded counts, `acceptedPairs` (what was actually paired, post-gate, post-exclusivity), and `topScores` (best candidate per Kalshi row **regardless of threshold or gate**). `topScores` is what distinguishes "real candidates just under threshold" from "nothing close" from "gate correctly rejecting". Write routes return per-stage `writes` counts and real error strings. **Keep this** — nearly every bug this codebase has had was invisible until the relevant counter/error was surfaced in the response.

## Polymarket US is a different exchange

`polymarket.com` and `polymarket.us` are **separate venues**, not
regions of one site: different market sets, different slugs, different
books. A US account can only trade `.us`, so pricing a Kalshi leg
against a `.com` book produces an edge the reader cannot take. Both are
stored — `markets.platform` is `polymarket` or `polymarket_us` — and a
game pairs against every venue that lists it.

Same claim, same moment, to show the books genuinely differ:

```
Kalshi         Bitcoin above $199,999.99 by Dec 31 2026   0.03 / 0.04
Polymarket US  Bitcoin above $200k by 12/31/2026          0.05
```

Public market data: **`gateway.polymarket.us/v1`, no API key** — and a
key would not add any. Polymarket US's own quickstart says market data
needs no authentication, and describes the keyed API as the one you
"use to trade". The **one** thing a key unlocks that matters here is
`wss://api.polymarket.us/v1/ws/markets` — market data, order book and
trades over a socket, which is key-gated and would replace the polling
this project does. It needs app KYC, and a socket needs an always-on
worker Vercel functions cannot host, so it is an architecture change
rather than a config one.

- **OPEN game markets are not returned by any list endpoint** — but
  closed ones are, which is why a sweep of `/v1/events` looks like it
  disproves this. `/v1/events` pages through `aec-` slugs
  chronologically from Oct 2025; `/v1/events?closed=false` returns 600+
  open events and **zero** games. So a game appears in the listing only
  once it can no longer be traded. **Live games are reachable only by
  slug**, which is why `.us` game discovery builds slugs from the `.com`
  side rather than enumerating.
- **`seriesSlug` is silently ignored.** `?seriesSlug=mlb-2026` and
  `?seriesSlug=mlb` return byte-identical pages of 2025 NFL games —
  the same trap as polymarket.com's ignored `tag=`/`search=`.
  `closed=false` is a real filter; assume nothing else is without
  checking that two different values return different rows.
- Slugs are `aec-<league>-<away>-<home>-<yyyy-mm-dd>` using the **same
  team codes and the same order as `.com`**, so a `.us` slug rebuilds
  from a `.com` slug with no second alias table, and `polyOutcomeIndex`
  carries over unchanged.
- **A `.us` WEB url is not `/event/<slug>`, and both shapes 404 in their
  own way.** A game is
  `/sports/<league>/<slug minus the aec- prefix>?marketSlug=<full slug>`.
  Everything else is addressed by its PARENT EVENT —
  `/event/us-saa-q3-2026-10-29?marketSlug=gdpc-us-saa-q3-2026-10-29-gt2pt0`,
  where `/event/gdpc-...-gt2pt0` is a not-found page. Both were read off
  polymarket.us's own markup; `lib/titles.js` builds them and
  `scripts/poly-us-url.test.mjs` pins both branches.
- **The event slug cannot be derived and is not on the market.** A `.us`
  market carries no eventSlug, eventId or ticker, the family prefix
  varies in length (gdpc, cpc, enwc, nphc, ushsscc, pnwpc, rdc, vtc),
  and `cpc-btc-100k-10-31-2026` belongs to the event `btc-100k` — the
  date is dropped. `fetchUsEventSlugs()` pages `/v1/events?closed=false`
  to build the map and stores it in `event_ticker`. It is a lookup only,
  so a gap there costs a link, never a market.
- **Status codes cannot test a `.us` URL.** The wrong route answers
  **200** and renders its not-found state client-side, and the `<title>`
  is inconsistent between identical requests — the same URL gave
  "Seattle Mariners vs. Boston Red Sox" once and a bare "Polymarket" the
  next time. Grep the body for a `page-not-found` marker AND for content
  that only the right page has, against a deliberately-wrong control.
- **`/v1/markets/<slug>/bbo` publishes `bidDepth`/`askDepth`.**
  `polymarket.com` publishes no depth at all, so a US pair is the only
  one that can report `depthKnown: true` instead of an upper bound taken
  from the Kalshi leg alone.
- **Fees differ per venue.** US prices its taker fee off
  `feeCoefficient` (0.06 on the MLB game checked) against `.com`'s
  `feeSchedule.rate` of 0.05. Read it per market; never assume the two
  charge alike.
- `outcomes`/`outcomePrices` are misaligned here too — a market with
  `outcomes ["No","Yes"]` returned `["0.0400","0.97"]` where 0.04 is the
  YES. Read `marketSides`, where each side carries its own price.
- **The listing horizon is the next SLATE, not a fixed number of days.**
  This file said "~2 days ahead" and NFL disproved it on the first run:
  12 US-tradable legs for fixtures 12 days out. Measured on 2026-09-01
  against pairs the site actually holds — MLB +0 to +2 days, NFL +12 —
  which is what a daily sport and a weekly one look like under the same
  rule. Do not code against a day count.

  A 404 means *not listed yet*, not an error; `fetchUsGameMarket`
  returns `notListed` so the two cannot be confused, and that is what
  makes the horizon a non-issue in practice.

  **Probe with REAL fixtures.** Testing this with constructed slugs
  proves nothing: `aec-nfl-was-dal-2026-09-13` comes back absent
  because WAS at DAL is played on the 20th, not because the venue is
  behind. An invented matchup and an unlisted one are the same 404.
- **Reads must use `POLY_PLATFORMS`, never `.eq("platform",
  "polymarket")`** — that filter excludes `polymarket_us` exactly, which
  is how 30 successfully fetched US markets produced zero US pairs while
  every counter looked healthy.
- Testing from a sandbox: a 403 reading `Host not in allowlist:
  gateway.polymarket.us` is the local egress proxy, **not** Polymarket
  and not the code. curl is proxied differently — verify with curl, or
  against the deployed route.

## Executable pricing (books + fees)

The arb number is what the trade actually costs, not what the midpoints
suggest. `lib/fees.js` owns the maths; `/api/markets` returns
`feesIncluded: true`.

**Both venues charge takers on the same quadratic curve** — most
expensive at 50/50, near zero at the extremes — and neither charges
makers:

```
Kalshi      contracts x 0.07 x fee_multiplier x p(1-p)
Polymarket  shares    x rate x (p(1-p))^exponent
```

**Fee parameters come from the APIs, never hardcoded.** Kalshi's
`fee_multiplier` is per-series on `/series/<ticker>` (0.5 on KXMLBGAME);
Polymarket's `feeSchedule` is on the market (`{rate, exponent,
takerOnly, rebateRate}`, rate 0.05 for sports). Polymarket changed its
rates mid-2026 — a constant in code goes stale silently and produces
confident wrong answers. Both are stored per market row.

- **A missing `fee_multiplier` means 1, not 0.** Defaulting it to zero
  prices every Kalshi leg as free and manufactures edges.
- **Kalshi rounds its fee up to the cent per ORDER.** Charging that
  against a single contract bills 1.00¢ where the rate is 0.875¢ — 14%
  high — so per-contract cost amortises over `DEFAULT_ORDER_SIZE`.
- **Polymarket quotes one book per market, on outcome 0.** The other
  outcome is its exact complement in a binary CLOB, so it is derived at
  read time (`complementBook`) using the same identifier-based outcome
  index the sports join uses. Storing both would let the copies
  disagree.
- **Depth goes stale far faster than price, and the cron is slower than
  it claims.** A stored 917-contract queue was really 44 by the time it
  was read — turning "+1.26¢, ~$11.55" into ~$0.56, a 20x overstatement
  on the one number a reader would act on. `/api/markets` therefore
  re-checks the Kalshi touch size **live** for pairs the maths calls
  profitable (a handful, batched by series) and reports
  `pricing.depthChecked` / `depthCorrected`. Prices tolerate staleness;
  sizes do not.
- **An edge without a size is not a finding.** The same Bitcoin strike family offered 7 contracts at one price and 710 at another — six cents of profit versus fifteen dollars. Kalshi publishes size on the YES book only, which covers both directions: taking NO at `no_ask` is the same trade as selling YES at `yes_bid`, so the YES bid queue backs it.
- **A missing ask yields `null`, not a big number.** "No executable
  price" and "no edge" are different answers; the card says which.
- **The threshold is $1.00**, because that is what a matched pair pays
  out. The old `< 0.97` cushion was standing in for costs that are now
  measured.
- **The <=15pt implausible-spread guard lives in the API, with the
  calculation — never only in a client.** It was in `pages/index.js`
  alone, so the site did not render the bad pair but `/api/markets`
  published `profitable: true` on it and every other consumer believed
  it. The live case: Kalshi had Delcy Rodriguez at 0.89/0.92 for
  Venezuela's de facto head of state — consistent with its own outcome
  set, which sums to 1.15 — against Polymarket's 0.09/0.10 on the
  identical-reading claim. Executable pricing called that a 78c edge
  because both legs were individually takeable.
  `pricing.implausibleArbs` counts what the guard catches, so degrading
  match quality stays visible.

Worked example — Kansas City vs Toronto on live books:

```
old  min(0.53, 0.545) + min(0.47, 0.455) = 0.9850  -> flagged ARB
new  0.5388 + 0.4724                     = 1.0112  -> -1.1c, not a trade
```

### Naming the venue is the whole point of the row

The bars read `KALSHI` / `POLY US` / `POLY`. Two labels differing by two
characters, a few cents apart, read as the same venue listed twice or a
typo — and worse, **the unqualified one is the one a US reader cannot
trade**: a reader who has heard of Polymarket takes the bare `POLY` for
the real one, and that is `polymarket.com`. It is now `POLY GLOBAL`, so
both labels name a jurisdiction and neither reads as the default.

The label column is 96px and `nowrap`; `POLY GLOBAL` wrapped to two
lines at 86px on a 375px screen. The "widest book" caption's
`paddingLeft` tracks that width plus the row gap, or it stops lining up
with where the bars start.

### /api/refresh is the exception, and deliberately so

Every other job route 401s the moment `CRON_SECRET` is set. This one
does not, because **the browser calls it**: `pages/index.js` requests
an on-demand read whenever what is on screen is over
`ON_DEMAND_AFTER_SECONDS` old. Gating it identically would have flipped
price freshness from ~20 seconds to whatever the throttled cron
manages — 45 minutes to 3.5 hours — the moment the secret was set, and
silently, because on-demand failure is silent by design.

So an unauthenticated caller is **allowed and pays the cooldown**:
`effectiveIfStale()` floors `ifStale` at 180s for them. The ↻ button
still refreshes whenever the prices are genuinely stale; what it cannot
do is force a venue read in a loop. Only a credentialed caller gets
`ifStale=0`.

**The floor applies whether or not one was asked for.** Omitting
`ifStale` entirely would otherwise buy an unconditional venue sweep,
which is precisely the thing being bounded — and it is the case a naive
implementation gets wrong. `scripts/cron-auth.test.mjs` pins it, along
with the requirement that nothing changes at all while `CRON_SECRET` is
unset.

The routes that spend money have no such exception: `/api/embed`
(Voyage), `/api/v2/extract` and `/api/v2/extract-eval` (Anthropic), and
the destructive `/api/prune` all close completely.

### Job routes are gated, including the ones that spend money

`lib/cronAuth.js` covered `/api/refresh`, `/api/embed` and `/api/prune`
from the start. It did **not** cover the v2 routes, which are the more
expensive half: `/api/v2/extract` and `/api/v2/extract-eval` spend
**Anthropic credits** per call, `/api/v2/backfill` and
`/api/v2/rematch?write=1` write through the service-role key. The repo
is public, so those urls are public. All four are gated now.

The gate is permissive until `CRON_SECRET` is set, so **setting that one
variable is what actually closes them** — on Vercel *and* as a GitHub
repository secret, or the workflows start 401ing. Verified open on
2026-09-03: `/api/prune?dry=1` answered 200 with no credential.

### An empty book is not a wide one

Both venues quote an untraded market as **best bid 0 / best ask 1** —
no orders, so the touch spans the whole probability range. Read
literally that is a two-sided market a hundred points wide, and the
card said exactly that: *"widest book 100.0pt"* next to a leg reading
*"no executable price"*. It also fed `bookMid`, which averaged 0 and 1
into a confident-looking **50%** and displayed it as the venue's price.

`realBook()` in `lib/fees.js` empties it. **Both edges are required**: a
one-sided book — a real bid with nothing offered, or an offer with no
bid — is genuinely quoted and stays, because "you can sell but not buy"
is a fact about the market rather than an absence of one. Kalshi's YES
and NO books are separate and each is tested on its own.

The complement is taken from the ALREADY-EMPTIED book, not from the
row: mirroring a raw 0/1 gives 0/1 back and the emptiness is lost.

**`complementBook` mirrored an ABSENT book into a `{bid: 1, ask: 1}`
quote**, because `Number(null)` is 0 and the finite check let it
through — a venue offering to sell at $1.00 that does not exist.
`bestArb` prices that out of any edge, so it hid inside the arb figure
and surfaced as a 100% mid on the card instead. Found by writing
`scripts/real-book.test.mjs`, not by reading the page.

### One card, N venues

A Kalshi market listed on both `polymarket.com` and `polymarket.us`
produces two rows in `pairs`, and the site used to render them as two
cards: the same fixture twice, a few cents apart, with nothing saying
they were the same claim. 66 sports pairs were 35 games. Since a US
account cannot trade `.com`, "which of these is mine?" was the first
question that layout raised and the last one it answered.

`/api/markets` now merges on `kalshi_id` and returns `legs[]`; the
response still calls them `pairs` but `pairCount` says how many stored
pairs it took.

- **Merged in the API, not the client**, for the same reason the
  implausible-spread guard is: the arb figures are computed there, and a
  client that recombined them would be a second place for that maths to
  live and a first place for it to drift.
- **Every leg keeps its own arb, cost and match score.** A single
  blended "best" number would quote an edge on `.com` to a reader who
  can only trade `.us`. The venues are separate exchanges, not mirrors.
- **The venue filter filters LEGS and drops cards left with none.**
  Filtering whole cards would hide a game the reader *can* trade just
  because its `.com` twin exists; leaving the other leg attached would
  quote them a price they cannot take.
- Every derived figure — spread, volume, age, arb badge, the stat row —
  reads the legs currently displayed, never all of them.
- The React key is the Kalshi id again. It was `pairId` precisely
  because one Kalshi market yielded two rows; merging removes the
  collision at its source.

### The front door leads with the category we can prove

Ranked by Kalshi contracts, the four home cards came out **politics,
economics, crypto, sports** — a presidential-nomination market trades
millions of contracts where a ball game trades thousands. True about the
venues, and a bad front door.

Politics is **70% of the catalogue** (289 of 410 cards, measured
2026-09-04) and the category matched by embeddings plus gates, where
wrong pairs are a known and recurring cost. Sports is matched by an
**exact join on the game identifier** and cannot pair the wrong
fixture. The strongest thing to be judged on was in the last slot.

The order of the four now follows the `CATEGORIES` map, so one place
decides it. Selection WITHIN a category is still most-traded, which is
what the caption claims.

### An alpha notice, instead of a password

Gating the site was the alternative and it is worse on every axis: it
costs the share card, indexing, and anyone we send to the domain —
Vercel wants Enterprise or a **$150/mo** Pro add-on for it, and the
Cloudflare Access route needs the orange cloud we deliberately turned
off. None of that touches the actual risk, which is a reader ACTING on
a pair the matcher got wrong. Arguably a gate makes it worse: an invite
list is people who will trade.

So the page says what it is, next to the prices. Muted and small — a
warning that shouts on every visit stops being read by the third one.

### The card says which sport it is

The sports tab mixes leagues in one grid, and "New York Y vs San Diego"
does not say whether that is baseball or football. Team names are the
only clue and they are ambiguous exactly where the cities overlap.
`LEAGUE_LABEL[market.category]` renders as a badge on sports cards
only, because the other tabs hold one kind of thing and the label would
be noise.

### Search is on every view, including the front door

The box lived inside the category branch, so the home page — the first
thing anyone sees — had no way to ask about a specific market. The
catalogue is **~86,000 markets against the ~960 that are paired**, so
the grid could only ever answer "what did we find" while the question a
reader arrives with is "what about this one".

- **`SearchBox` is one component rendered in three places** (home hero,
  above the category tabs, above the results). Duplicating the markup
  would be three places for the placeholder, the clear button and the
  Escape key to drift apart.
- **Order differs by view, deliberately.** On the home page the box sits
  UNDER the hero: a control before any context asks the reader to act
  before they know what the site is. On a category tab it leads, because
  they already know.
- **It must render in search mode too**, or typing makes the thing you
  are typing into disappear — the box only existed inside the branches
  that searching replaces.
- Searching replaces the whole view rather than appearing under it.
  Leaving the home cards below the results answers a question nobody
  asked, underneath the answer to the one they did.

### The home page shows cards, not a description of cards

The front door read as a hero paragraph, four category tiles and a list
of twelve titles. It told a new reader what the site was and gave them
no reason to care: a price-comparison product that compared no prices
above the fold.

It now leads with **four real `MarketCard`s, one per category**, taken
from `?category=all&perCategory=3` — which the API already ranks by
Kalshi contracts, so the first of each tab is that tab's most-traded
market and the split is a single pass over the response.

- **The tiles are the FALLBACK, not the front door.** Each card header
  carries the category, its `byCategory` count and the way into that
  tab, so a tile row above them says the same four things twice and
  pushes the product below the fold. They render only when there are no
  cards — a cold cache or a failed read still needs a way into every
  tab.
- **The home cards show the venue you can trade, and SELECTION MOVES
  WITH THE FILTER.** Every category tab defaults to `venue = "us"` and
  the front door did not, so the same market rendered three bars here
  and two there — `POLY US 16%` above `POLY GLOBAL 14%`, with the
  untradable row reading as a third opinion. Filtering alone is not
  enough: crypto's most-traded market is on polymarket.com and **not**
  on polymarket.us, so dropping its only Polymarket leg leaves a
  price-*comparison* card with one price. The featured card is
  therefore the most-traded one in each category **that has a US leg**,
  falling back to the plain top card if a category has none — its
  global leg beats an empty slot, and that leg already says "can't
  trade from the US" on its own line.
- **No venue toggle here.** Each card header carries `See all N →` into
  the tab, where the full US / Global / Both control lives with real
  counts. A venue filter over four cards is a control whose effect the
  reader cannot yet see the point of.
- **The list below shows what the cards do not.** `featured` takes the
  first of each category and `rest` takes the remainder, so nothing
  appears twice and the list keeps its own job, which is breadth.
- **`onPin` is optional on `MarketCard`.** Pinning answers "keep this
  in view while I scroll past four hundred others", which the home
  page's four cards do not raise; rendering the control there would
  offer a button whose effect is invisible on the page you are on. The
  age label takes over the auto margin that the pin button carried.
- **`showTrending` is off here.** `market.trending` is a volume FLOOR
  (`> 5000`), not a trend, so on a page that selects the top-volume
  market in each category it is true on every card by construction. A
  badge that is always lit says nothing and costs a glance. That the
  flag is misnamed everywhere is a separate, open problem.
- The "Also trading" rows put the category ABOVE the title rather than
  in a column beside it: a 74px label column plus a volume column left
  a 375px screen about 120px for the title, which wrapped to four lines
  and made the secondary list taller than the cards above it.

### Mobile

**There was no viewport meta tag in the app at all**, so a phone laid
the page out at ~980px and scaled the result down: every card "fit" and
every word was unreadable. It lives in `_app.js`; Next rejects a
viewport tag in `_document` and warns.

The grid needs no media query. `minmax(380px, 1fr)` forces a track
wider than a 375px screen; `minmax(min(380px, 100%), 1fr)` clamps it to
the container, so one declaration gives two columns on a laptop and one
on a phone. Gutters are `clamp(12px, 4vw, 24px)`.

Verified in Chromium at 375x812 and 1280x900 against captured
production data: `scrollWidth === clientWidth` at both.

### What the card must admit

The arb number is only as good as what the reader knows about it, so
every uncertainty in the calculation has a surface in the UI. This is
not decoration — each one exists because its absence misled someone.

- **Price age** (`0010`, `priceAgeSeconds`). The header used to read
  "Updated 3:42 PM" off the **browser's fetch clock**, which is not a
  fact about the prices on screen: `refresh-prices.yml` asks GitHub for
  every 15 minutes and gets 45 minutes to 3.5 hours, so a book read at
  noon rendered as current. A pair reports the **staler** of its two
  legs — it is only as current as its worse side — the header reports
  the stalest leg on the tab, and both go amber past two hours, which
  is long enough that a run was actually missed rather than merely
  late. Cards carry their own age next to the arb badge: a flagged edge
  on a three-hour-old book is the one combination that costs money, and
  it looked exactly like a fresh one.
- **`depthKnown: false`** and the `≤` prefix — Polymarket publishes no
  size, so `maxContracts` is an upper bound set by the Kalshi leg.
- **`arb: null`** renders as "no executable price", never as zero edge.
- **`hidden`** — pairs stored but not shown (long shots outside
  0.05–0.95, settled fixtures, missing price). Economics is 6 pairs out
  of 2,208 Kalshi markets and that is the product working, but "we
  found almost nothing" and "we found things and hid them" look
  identical from outside. It was counted all along and reported only
  behind `?debug=1`, where no reader would see it.
- The legend says prices come from a scheduled read, not that the page
  "auto-refreshes every 60s" — true of the page, not of the numbers.
- **Volume is three different quantities and is never summed.** Kalshi
  reports CONTRACTS (`volume_fp`), polymarket.com reports US DOLLARS
  (`volumeNum`), and polymarket.us publishes no volume field on a market
  at all. Adding them produced a "Total volume" that reconciled with
  neither exchange. Kalshi's is also the TOTAL, not `volume_24h_fp`:
  across KXFED's 98 markets the 24h figure sums to 72k against the
  total's 4.29M, so every market read about sixty times too small.
  polymarket.us volume is `null`, not `0` — a fabricated zero read as
  "nobody has traded this", which is a claim about the market rather
  than about our data.
- **"No trades yet"** replaces `Vol $0`, and only where the venue
  actually reports zero. A cost figure on a market nobody
  has traded is not a quote anyone can take, and `$0` beside "104.9¢ to
  own both sides" reads as a number rather than a warning. Six of
  eighteen economics cards are in that state.

And what it must NOT repeat. `cleanTitle()` in `markets.js` strips
Kalshi's raw markdown (`**real GDP**` reached the card verbatim) and
drops a trailing side label only when the question already states that
exact value with its unit. The rule is deliberately narrow because the
failure modes are asymmetric: a label left on is noise, a label wrongly
removed loses which side the price belongs to — a looser first version
turned "Miami vs Washington (Aug 29) — Miami" into a card that no longer
said which team was at 51%. For the same reason the match score and the
Polymarket title now render only when similarity < 1: on a sports pair,
which joins on the game identifier, they were "100% match" and a
paragraph restating the card title, on every card.

`supabase/migrations/0004` adds `bid`/`ask`/`no_bid`/`no_ask`,
`bid_size`/`ask_size`, `fee_multiplier`/`fee_schedule`, and rebuilds
`get_pairs`. **`no_bid`/`no_ask` are Kalshi-only on purpose**: a Kalshi
binary has a genuinely separate NO book (not `1 - yes`), while
Polymarket's is a derived complement.

Because the migration is run by hand, a deploy can land before it does.
Both write paths detect the missing columns, retry without them, and
return a warning naming the migration — a price refresh degrades instead
of failing outright.

## Current match reality (as of last verification)

Every pair below was read and confirmed by hand; the counts are small on
purpose. A wrong pair renders a fake arbitrage, so precision beats recall.

| Category | Cards | Stored pairs | US-tradable cards | Floor |
|---|---|---|---|---|
| sports (ncaaf) | 148 | 219 | 0 | exact join, by NAME |
| sports (mlb) | 44 | 69 | 38 | exact join |
| sports (nfl) | 25 | 37 | 25 | exact join |
| economics | 24 | 34 | 20 | 0.81 |
| crypto | 15 | 27 | 3 | 0.88 |
| politics | 373 | 881 | 31 | 0.86 |

All five rows read from `/api/markets` on 2026-09-01, not carried over
from an earlier revision. **Only "Stored pairs" is stable.** "Cards" and
"US-tradable" are functions of LIVE PRICES — a pair whose quote drifts
outside 0.05-0.95 stops rendering and comes back later — so they move
between reads without anything being wrong. Politics went 51 -> 31
US-tradable in a day on price movement alone. Treat a change in those
two columns as weather; treat a change in "Stored pairs" as the
matcher having run.

"Cards" is what the site renders — one per Kalshi market, with a leg per
Polymarket venue. "US-tradable" counts cards carrying a `polymarket_us`
leg, which is what a US account can actually act on and what the venue
filter defaults to.

"Shown" is lower than "stored" because `markets.js` drops prices outside
0.05–0.95, and the extra politics pairs are long shots (the seven-person
Venezuela set, pardon markets) trading under a nickel.

**Politics went from 4 pairs to 905, and the gates are why.** Kalshi's
Elections category is 12,331 embedded rows against Polymarket's 11,367,
and the first run off Vercel accepted 1,234 pairs of which roughly 84%
were wrong. Four audit rounds took it to 905 with two known-wrong. What
the rounds cost is recorded in `scripts/gate-cases.test.mjs` — 48
rejections against 43 pairs verified by hand — and every gate there
exists because a real run produced a real wrong pair.

**Read the whole accepted list before publishing, never the log tail.**
`scripts/match-category.mjs --out=` writes every pair as TSV and the
workflow uploads it; the log prints 40 and `acceptedPairs` caps at 100.
A thousand pairs is only auditable collapsed into templated families —
a systematically wrong family is one entry with 419 members, and
invisible spread across 419 rows.

**84 politics legs price as profitable, and that is not 84 findings.**
80 of them are polymarket.com only, which a US account cannot trade,
and of the 5 that are US-tradable NONE has ten contracts behind it. The
largest edge on the tab is a quarter of a cent. The count looks alarming
and the substance is thin, which is exactly what "an edge without a size
is not a finding" means at scale.

Economics: **6 verified-correct pairs** out of 2,208 Kalshi econ markets
— five annual/quarterly real-GDP thresholds and the negative-growth
market. Each was read by hand against Kalshi's `rules_primary`, not its
title.

It was 1 pair out of 163 until `KALSHI_CATEGORIES` gained `econ` and
started fetching the whole Economics category instead of four hardcoded
series. **"No overlap" was a claim about a truncated input, and it was
wrong** — the same mistake as the `.us` listing sweep. Before concluding
a venue does not list something, check what the fetch actually asked
for.

Widening it produced 26 pairs, of which roughly 6 were right, and
getting from there to 6 correct took three audit rounds. The gates that
came out of it: direction on counted changes, calendar coordinates
excluded from `hasUnparsedValue`, bare `X% to Y%` spans, number-first
bucket labels (`6.1% or Above`), spelled-out thresholds (`hit zero`,
`negative growth`), nominal-vs-real GDP, and econ metric sets.

**An audit is only valid against the run it was read from.** Matching is
globally greedy, so rejecting one candidate re-opens its counterparty to
everything ranked below it. Round 3's wrong pair did not exist in round
2's output — it appeared *because* the nominal-GDP pair was fixed. Re-run
`matchonly&dry=1` and re-read after every gate change.

Econ's floor moved 0.78 -> **0.83**. Every verified-correct pair scores
0.835 or better, and three audit rounds found nothing but wrong pairs
below 0.83 — each one a claim shape no gate yet read. It is defence in
depth behind the gates, **not** a substitute: the worst pairs found here
scored 0.924 (nominal vs real GDP) and 0.869 (zero rates vs any cut),
well above any floor worth setting.

Kalshi lists ~9 GDP threshold buckets per quarter where Polymarket lists
one, and Polymarket's "interest rates" tag (131) is mostly ECB/Bank of
England — both correctly filtered.

Crypto's floor is 0.88. It sat at 0.90 only because the "positive
return" family had no gate; with `strikePresenceCompatible` and
`rankingCompatible` rejecting that family on claim shape rather than on
score, the floor moved to what real matches need — the genuine
Kalshi/Polymarket US overlap ("above $199,999.99" vs "above $200,000 in
2026") scores **0.890** and was missing the cut by a hundredth.

The historical reason it could not be 0.94: Kalshi phrases every
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
- **The dashboard SQL editor times out at ~60 SECONDS, and it cannot be
  raised from the dashboard.** The failure surfaces as
  `Error: Failed to fetch (api.supabase.com)` with `0 rows` — which
  looks like a broken statement and is a broken *request*. The statement
  is cancelled when the connection drops, so nothing half-applies.
  Anything long — `VACUUM FULL`, a big backfill, an index build over a
  large table — has to run over a **direct connection** instead
  (Project Settings -> Database -> **Session pooler**, port 5432; the
  transaction pooler on 6543 does not support session-level settings):

  ```
  psql "<session-pooler-url>" -c "set statement_timeout = 0;" \
                              -c "vacuum (full, analyze) markets;"
  ```

  Do not hand a `VACUUM FULL` to the SQL editor and expect it to run;
  at 776MB it never had 60 seconds' hope.
- **Always hand over a LINK, never just a migration number.** Anything
  the user has to run by hand — a migration, a diagnostic query, a
  one-off statement — is delivered as
  `https://github.com/albatrossbird/housedge/blob/main/supabase/migrations/<file>`,
  because the SQL editor is a different window from the repo and
  "run 0014" makes them go looking for it. Paste the SQL inline only
  when asked, or when there is no file to point at.
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

**v2 is fee-aware too, as of migration 0006.** Its quotes were backfilled from v1 before v1 stored books, so they carried `mid` only and the arb calc fell back to it. `0006` adds `bid_size`/`ask_size` to `quotes` and `fee_multiplier`/`fee_schedule` to `listings`, the backfill seeds real books (deriving Polymarket's no-side as the complement rather than storing it twice), and `computeArb` prices every leg through `lib/fees.js`. Both `/api/markets` and `/api/v2/markets` now report `feesIncluded: true`.

v2's calc is the generalisation v1 cannot express: it sums N outcomes across any number of venues, picking the cheapest venue per outcome, and caps the set at its thinnest leg. **`0006` drops and recreates both views** — `latest_quotes` and `v2_market_view` — because `CREATE OR REPLACE VIEW` can only append columns and these insert them mid-list. Drop the dependent view first.

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
- **Never `select=*` from `markets` in a price path.** The refresh job's select-merge-upsert pulled the full row so the payload would carry every NOT NULL column, which dragged a ~20KB embedding per row through the select *and* back through the upsert to rewrite a few price fields. Postgres killed the 100-row chunk with `57014 canceling statement due to statement timeout` and `polyUpdated` came back 0. List the columns instead — all of them except `embedding`, because a partial payload still fails NOT NULL `platform` with 23502.
- **A read that fails must not look like an empty table.** `fetchAllRows` did `if (error || !data || !data.length) break` and returned what it had, so a first-page failure returned `[]`. Selects carrying `embedding` are ~20KB a row, so a 1000-row page is ~20MB, and once crypto and politics passed ~4,000 Polymarket rows the first page stopped coming back — the category read as zero stored markets while the live site served pairs built from those rows. Paging now halves the page and retries before giving up.
- **An error channel that cannot carry an error is worse than none.** `matchonly` declared `const kalshiReadError = null` and mapped it into `readErrors`, so the response reported `readErrors: []` because it was structurally incapable of anything else. Check that a diagnostic field *can* be non-empty before trusting it.
- **PostgREST rejects a bulk insert whose objects have different keys** (`PGRST102`, "All object keys must match"). Kalshi and Polymarket rows are upserted together and legitimately diverge — only Kalshi has `no_bid`/`no_ask`/`series_slug`/`fee_multiplier`, only Polymarket has `fee_schedule`. `alignKeys()` fills the gaps with null. This was invisible until migration 0004 ran, because stripping the absent columns from both platforms happened to make the key sets match.
- **`.in()` puts its values in the query string, so a few thousand ids build a URL long enough to kill the request.** Clearing politics' pairs meant `.in("kalshi_id", [...1774 ids])` — a ~40KB URL — and supabase-js returns that as an error object the call sites were ignoring, so clearing looked like it worked. The visible symptom was a re-match at a corrected threshold writing its new pairs while every stale wrong one survived. Chunk at ~200 ids and check the error.
- Non-sports matching in normal mode must clear existing pairs for the category before rematching, or stale wrong pairs survive: upsert only overwrites when *both* ids match, so a Kalshi row matching a *different* Polymarket market just adds a second row.

### Kalshi

- Base URL must be `https://api.elections.kalshi.com/trade-api/v2` — `api.kalshi.com` and `trading-api.kalshi.com` are wrong/dead.
- Prices come from `yes_ask_dollars`/`yes_bid_dollars` as decimal strings (`"0.4200"`), not the `_fp` fields (those return `"0.00"`).
- Default `/markets` is dominated by `KXMVE*` parlay tickers — always filter `!ticker.startsWith("KXMVE")`.
- **`/events` has NO server-side category filter.** `?category=Economics`,
  `?category=Crypto` and a deliberately-invalid value return
  **byte-identical pages** — the same trap as polymarket.us's
  `seriesSlug` and polymarket.com's `tag=`/`search=`. `?series_ticker=`
  IS real (an invalid one returns `[]`), but Elections alone is 1,662
  series against 62 pages for the whole exchange, so per-series calls
  are far worse than paging. Category selection has to happen
  client-side, which is why the sweep pages everything and filters.
- **A whole-exchange sweep is 62 pages / 12,356 open events** (measured
  2026-09-01). Any sweep reporting materially fewer has not seen the
  exchange, whatever its own counters say — the first version reported
  `truncated: pages >= maxPages`, which is FALSE when the loop broke on
  an HTTP error, so econ shipped **600 of 12,356 events and reported a
  clean run**. `complete` is now true only on an exhausted cursor, a
  failed page retries four times with backoff and then names the status
  and body, and an incomplete sweep fails the workflow. The sweep is
  also fetched **once per invocation and shared**: econ ran Economics
  and Financials through `Promise.all`, paginating the same 12,356
  events twice, concurrently, against an endpoint that rate-limits
  datacenter IPs.
- **Web URLs are three segments**: `/markets/<series>/<event-slug>/<event-ticker>`, all lowercase.

  ```
  kalshi.com/markets/kxmlbgame/professional-baseball-game/kxmlbgame-26aug271910milnym
  kalshi.com/markets/kxrecogsomali/somaliland-recognition/kxrecogsomali-29
  ```

  **The series segment alone is not a route** — `kalshi.com/markets/kxgdp` errors, and an earlier note in this file claiming it resolved is what made every Kalshi link on the site dead. A path built from the full market ticker also fails.

  The middle segment is the **series title, slugified** (`"Somaliland recognition"` → `somaliland-recognition`). It is returned by `/series/<ticker>` and appears nowhere on the market or the event, so `embed.js` fetches it once per series — on the same call that reads `fee_multiplier` — and stores it as `markets.series_slug`. The other two segments come from the ticker (`id.split("-")[0]` and `event_ticker`).

  Without a slug there is no constructible market URL, so `markets.js` falls back to `kalshi.com/search?q=<title>`, which is a real route. **Never fall back to the bare series path.**

  Note that kalshi.com sits behind Vercel bot protection and returns 429 to datacenter IPs, so these URLs cannot be verified with curl from a sandbox — they were confirmed against pages in a search index instead.

### Polymarket

- Default `/markets?active=true&closed=false` only returns high-volume *featured* markets. Individual markets require `/events?tag_id=X` with `offset` pagination. Only numeric `tag_id` filters — `tag=`, `label=`, `search=` are silently ignored.
- Polymarket publishes no fixed tag list; discover IDs by paging `/tags` and matching label/slug. Known: soccer `100350`, nba `745`, nhl `899`, mlb `100381`, federal reserve `129`, interest rates `131`, Macro Inflation `101249`, recession `100201`, GDP `370`.
- The `?id=` batch filter needs the key repeated (`?id=1&id=2`), not comma-joined.
- **`?id=` silently omits closed markets** unless `closed=true` is also passed, and a non-integer id 422s the *whole batch*.
- **`/markets` applies a default `limit` of 20 no matter how many `id=` values you pass**, and returns the truncated list with a 200. A 50-id batch came back with 20; two batches came back with 40, which was `polyFetched` exactly while 34 of 35 global Polymarket sports legs sat five hours stale. Always send `limit` explicitly, and compare asked-for against came-back — `polyShortfall` does. Both are why `/api/refresh` returns fewer Polymarket rows than it asked for; the omission is correct behaviour for us (a closed market should not display), the 422 was not, and is now filtered on.
- The "event has ≤4 markets" heuristic separates single games from tournament futures for **sports only** — a Fed decision legitimately has more outcomes. `fetchPolymarkets()` skips that filter for non-sports tags.
- `outcomePrices` doesn't always align index-for-index with `outcomes`. Still unfixed; mitigated only by the ≤15pt arb spread guard.

### Matching generally

- Bulk keyword/fuzzy matching across all markets (the original approach) produced repeated false positives — cross-sport matches on shared words, tournament-winner markets matching single games, sibling markets within an event getting swapped, date noise diluting scores. Hence per-category scoping and structured gates.
- Game identity lives in IDs, not in the titles — which is the whole basis of sports matching now. See "Sports matching".

## Known bugs / open work (priority order)

1. **Embedding storage is the real tier pressure, and `/api/prune` does not touch it.** ~11,300 embedded rows (politics 7,443, crypto 3,870) at ~20KB of JSON-encoded floats each is roughly 225MB of a 500MB tier, and only 62 of them are in a pair. They cannot simply be deleted — the unpaired ones *are* the candidate pool, and dropping them means re-embedding next run. **pgvector is the lever**: `vector(1024)` as float4 is ~4KB against ~20KB, a 5x reduction with no loss of function. Already the plan in `docs/architecture-v2.md`; now the thing standing between this project and the ceiling.
2. **Polymarket publishes no depth.** Gamma exposes aggregate liquidity but no size at the touch, so any leg on that venue reports `depthKnown: false` and `maxContracts` is an upper bound set by the Kalshi leg alone. Closing this means the CLOB API (`clob.polymarket.com/book`), which is a per-market call on a different host.
3. **Polymarket outcome-price ordering** — `outcomePrices` vs `outcomes` index misalignment can attribute the wrong side's price. A sanity check (`prices[0] + prices[1] ≈ 1.0`, both in 0.05–0.95) would catch a misindexed pick.
5. **We fetch four of Kalshi's 262 per-game series, and two are out of
   season.** `KXWCGAME` (World Cup) and `KXNHLGAME` both had **zero**
   open markets on 2026-08-31, which is why soccer sat at 9,888 stored
   Polymarket rows against **zero** pairs — a fifth of the catalogue
   paying storage for a Kalshi side that was never wired up. Live and
   unfetched on the same day: `KXMLSGAME` 132, `KXLALIGAGAME` 63,
   `KXEPLGAME` 60, `KXSERIEAGAME` 60. NFL is now wired (below); the
   rest are the obvious next win.

   The series list is `/series?category=Sports` — 3,627 of them, 262
   ending in `GAME`. Before concluding a league is absent from Kalshi,
   check that list rather than the four tickers this file used to name.
6. **NFL specifics.** Kalshi's tickers carry **no start time**
   (`26SEP21NYGLAR`) where MLB's do (`26SEP031940MIAKC`);
   `kalshiGameKey` already strips an optional `HHMM`, so both parse.
   Polymarket's NFL tag is **450**, its game events carry 29 markets
   (spreads, totals, props) and are kept by the `teams.length === 2`
   branch rather than the `<= 4 markets` heuristic, then narrowed by
   `sportsMarketType === "moneyline"`. `scripts/sports-keys.test.mjs`
   pins the join, the outcome index and the LA/LAC alias.
7. **NHL and soccer are still unverified against the join** — both had
   zero open Kalshi markets when it was built. `kalshiKeyFailures` in
   `matchDiagnostics` is what will say so.
6. **Polymarket US non-sports titles come from `titleShort`, not `question`.** Every market in a templated family shares ONE question — all six GDP strikes are "US GDP Growth in Q3 2026?", every candidate in a race is the same "Who will win…?" — and the distinguishing text ("Above 2.5%", "$200,000", "Jon Ossoff (D)") lives in `titleShort`. 5,866 of 5,877 non-sports US markets share a question with a sibling, so reading only `question` stored the catalogue as **1,073 distinct titles instead of 5,877**.

   This was recorded here for a long time as a measured fact about venue overlap ("crypto matches exactly one, politics matches zero"). It was this bug. Reading `titleShort` took econ from 0 US-tradable pairs to 14 and crypto from 1 to 4. **The lesson is the same one the `.us` listing sweep and the truncated Kalshi econ fetch taught: before concluding a venue does not list something, check what the fetch actually kept.**

   Politics really does match zero, and that claim is now worth something: the full 5,640-market US politics catalogue is ingested with correct titles and embedded, and everything down to threshold 0.80 was read by hand. The near-misses are all 0.86–0.89 and all wrong — Kalshi's "next person to leave the Trump Cabinet" is an exclusive race against Polymarket's "announced out in 2026", which is not, so someone leaving *second* resolves NO on one and YES on the other.
7. Polymarket's `outcomes`/`outcomePrices` alignment is still unverified for non-sports markets. Sports no longer depends on it (the index comes from the identifiers), but crypto/politics/econ still read `outcomePrices[0]`.

**Fixed since the last revision of this file:** automated refresh (both
GitHub Actions workflows), crypto and politics wired end to end, the
1000-row server-side cap, and `.in()`-based pair clearing.
