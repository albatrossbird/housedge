-- An index for the query the matcher lives on.
--
-- SYMPTOM, measured 2026-09-08: politics could not match AT ALL.
--
--   GET markets?select=id,title,platform,sport_tag,embedding_v
--       &platform=eq.kalshi&sport_tag=eq.politics&embedding_v=not.is.null
--       -> 500 {"code":"57014","message":"canceling statement due to
--                statement timeout"}
--
-- econ and crypto completed in the same run, so this is about size
-- rather than shape: `markets` went from 63,000 rows to 133,000 when
-- the polymarket.us page cap was lifted.
--
-- `markets` has no index supporting this predicate. The only ones on
-- the table are markets_title_trgm (search), markets_platform_volume
-- (search ranking) and the primary key; migration 0014 dropped the
-- three HNSW vector indexes as never-scanned. So the planner filters
-- the whole table for every page.
--
-- KEYSET PAGING ALONE DID NOT FIX IT, and the reason is worth keeping.
-- Converting the pager from OFFSET to keyset was correct and necessary
-- — an OFFSET pager is O(n^2) and had no ORDER BY at all — but the
-- binding cost is the LAST page: to prove there are no more matching
-- rows, Postgres must walk the remainder of the primary key and test
-- every row. That is a full scan whatever the page size, which is why
-- the pager's halving retry shrank the page to 62 rows and STILL timed
-- out. A page size cannot fix a predicate with no index.
--
-- The index is deliberately shaped to the query, in order:
--   sport_tag, platform  the two equality filters
--   id                   the keyset cursor and the ORDER BY
-- so a page becomes a range scan that returns exactly the wanted ids
-- already sorted — no filter, no sort, and the last page ends at the
-- end of the range instead of at the end of the table.
--
-- PARTIAL on `embedding_v is not null`, which is the third filter and
-- also what the matcher means by "a candidate": rows without a vector
-- cannot be matched and do not belong in the index. That keeps it
-- small — it covers the embedded subset, not all 133,000 rows.
--
-- Plain CREATE INDEX rather than CONCURRENTLY, following 0013: the
-- Supabase SQL editor runs statements in an implicit transaction and
-- CONCURRENTLY is not allowed inside one. It takes a brief write lock
-- on `markets`; at this size that is seconds, and the write paths
-- retry.
create index if not exists markets_category_keyset
  on markets (sport_tag, platform, id)
  where embedding_v is not null;

-- The refresh and discovery paths filter the same way without the
-- vector predicate (they read prices and titles for a category), and
-- they are on the same growth curve. Same columns, no partial clause.
create index if not exists markets_category_lookup
  on markets (sport_tag, platform, id);

analyze markets;
