-- A trigram index for /api/search.
--
-- Search runs `title ILIKE '%q%'` once per platform. Without an index
-- that is a sequential scan of `markets`, which was ~23,000 rows when
-- search was written and is 52,701 now. It already failed in
-- production: `q=Mariners` returned
--
--   {"error":"markets[polymarket]: canceling statement due to
--     statement timeout"}
--
-- once in ten queries, while the other nine ran 350-850ms. An
-- intermittent timeout is the worst version of this — it looks like a
-- blip rather than a capacity problem, and it gets steadily more
-- frequent as the catalogue grows.
--
-- gin_trgm_ops indexes the column directly and serves both LIKE and
-- ILIKE, so the query in pages/api/search.js needs no change. A
-- leading-wildcard pattern is exactly the case a B-tree cannot help
-- with and a trigram index can.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: the Supabase SQL editor
-- wraps statements in a transaction and CONCURRENTLY cannot run inside
-- one. On 52,701 rows this builds in seconds; it takes a write lock on
-- `markets` for that time, so run it when discovery is not mid-write.
--
-- Idempotent.

create extension if not exists pg_trgm;

create index if not exists markets_title_trgm
  on markets using gin (title gin_trgm_ops);

-- Search also filters `platform = $1` before ordering by volume. This
-- is the supporting index for that half; the trigram one above is what
-- makes the text predicate cheap.
create index if not exists markets_platform_volume
  on markets (platform, volume desc nulls last);
