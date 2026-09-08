-- 0018 may not have completed. Check first, then build ONE AT A TIME.
--
-- 0018 asked the SQL editor for two index builds over 133,000 rows plus
-- an ANALYZE, in one go. This repo already records what that costs:
--
--   "The dashboard SQL editor times out at ~60 SECONDS ... Anything
--    long - VACUUM FULL, a big backfill, AN INDEX BUILD OVER A LARGE
--    TABLE - has to run over a direct connection instead."
--
-- and that the failure "surfaces as Error: Failed to fetch
-- (api.supabase.com) with 0 rows - which looks like a broken statement
-- and is a broken REQUEST." The statement is cancelled when the
-- connection drops, so nothing half-applies: an index that ran out of
-- time simply does not exist, and the matcher still times out exactly
-- as it did before.
--
-- After 0018 was reported as run, the politics match still failed with
-- 57014. So the first thing to establish is whether the indexes are
-- actually there. Everything below is idempotent and safe to re-run.

-- ── STEP 1: what exists right now ────────────────────────────────
-- Run this ALONE first. Expect two rows. Zero or one means 0018 did
-- not finish, and that is the answer rather than a reason to look
-- further at the query.
select indexname, indexdef
from pg_indexes
where tablename = 'markets'
order by indexname;

-- ── STEP 2: build them, ONE STATEMENT PER RUN ────────────────────
-- Run each of these on its own, not as a batch. A single index over
-- the embedded subset is the one the matcher needs; the second is for
-- the refresh and discovery paths and can wait.
--
-- If either times out in the editor, it needs the session pooler
-- (Project Settings -> Database -> Session pooler, port 5432 - the
-- transaction pooler on 6543 does not support session-level settings):
--
--   psql "<session-pooler-url>" \
--     -c "set statement_timeout = 0;" \
--     -c "create index concurrently if not exists markets_category_keyset
--           on markets (sport_tag, platform, id)
--           where embedding_v is not null;"
--
-- CONCURRENTLY is available over psql because it is not wrapped in a
-- transaction there, and it avoids taking a write lock on markets for
-- the duration. It is NOT available in the SQL editor, which is why
-- 0018 did not use it.

create index if not exists markets_category_keyset
  on markets (sport_tag, platform, id)
  where embedding_v is not null;

-- ── STEP 3: the second index, separately ─────────────────────────
create index if not exists markets_category_lookup
  on markets (sport_tag, platform, id);

-- ── STEP 4: stats, separately ────────────────────────────────────
-- An index the planner has no statistics for may not be chosen.
analyze markets;

-- ── STEP 5: prove the planner uses it ────────────────────────────
-- The query the matcher actually issues. Expect an Index Scan or
-- Index Only Scan on markets_category_keyset. A Seq Scan here means
-- the index exists and is NOT being used, which is a different problem
-- from it not existing - and worth knowing before changing any code.
explain analyze
select id, title, platform, sport_tag
from markets
where sport_tag = 'politics'
  and platform = 'kalshi'
  and embedding_v is not null
order by id
limit 500;
