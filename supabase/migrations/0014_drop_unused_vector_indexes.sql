-- Drop the HNSW vector indexes. They have never been used.
--
-- MEASURED, not assumed. pg_stat_user_indexes on 2026-09-01:
--
--   markets_vec_poly_crypto     62 MB    idx_scan 0
--   markets_vec_poly_politics   50 MB    idx_scan 0
--   markets_vec_poly_econ     1656 kB    idx_scan 0
--   markets_pkey              3864 kB    idx_scan 4,132,005
--
-- 114 MB of the table's 121 MB of indexes, scanned zero times since
-- they were built.
--
-- They are not used because the code path that would use them is
-- switched off. match_candidates() is opt-in behind ?matcher=sql and
-- stays off because .range() on an RPC re-executes the function per
-- page rather than paginating a cached result: crypto costs four full
-- k-NN sweeps and 88s where the JavaScript matcher takes seconds, and
-- politics blows past the statement timeout entirely. Until that is
-- fixed, these indexes are storage spent on a disabled feature.
--
-- The database was 800 MB against a 500 MB tier when this was written,
-- so 114 MB is not a rounding error.
--
-- REVERSIBLE: migration 0007 is idempotent and recreates every one of
-- these. Re-run it when the SQL matcher becomes viable — which needs
-- the score floor pushed into the RPC so a category's candidates fit
-- in one page, and EXPLAIN confirming the index is actually used (323
-- probes taking 22s suggests it was not, even when it ran).
--
-- BE AWARE: because 0007 recreates them, running 0007 after this
-- migration undoes it. That is the correct behaviour — 0007 is the
-- definition of the vector path — but it means this is a decision to
-- re-take rather than a one-way door.
--
-- Dropping an index returns its space immediately, unlike nulling a
-- TOASTed column, which only marks space reusable.

drop index if exists markets_vec_poly_crypto;
drop index if exists markets_vec_poly_politics;
drop index if exists markets_vec_poly_econ;

-- Any other per-category vector index built by 0007 for a category not
-- listed above. Named dynamically because 0007 creates one per
-- (platform, sport_tag) pair and the set grows with the categories.
do $$
declare
  idx record;
begin
  for idx in
    select indexname from pg_indexes
    where schemaname = 'public'
      and tablename = 'markets'
      and indexname like 'markets_vec_%'
  loop
    raise notice 'dropping leftover vector index %', idx.indexname;
    execute format('drop index if exists %I', idx.indexname);
  end loop;
end $$;
