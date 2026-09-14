-- Exact on-disk size per table, which PostgREST cannot serve.
--
-- scripts/storage-report.mjs measures ROW COUNTS over REST and
-- multiplies by an assumed per-row width. That is good enough to spot
-- a trend and wrong enough to matter for a capacity decision — this
-- project once believed it held ~11,300 embedded rows and actually
-- held 37,518, a 3.3x miss that changed the conclusion.
--
-- Run this in the Supabase SQL editor for the real number. It is a
-- catalogue read, so it returns instantly and touches no data.
--
-- MEASURED 2026-09-14: 771 MB, against the script's 0.269 GB estimate.
-- A 2.8x miss, and the estimate was low for a specific reason it has
-- since been taught: `markets` carries a vector(1024) on embedded rows
-- at ~4KB each, and the script charged every row a flat 600 bytes.
--
-- Note also that the two numbers below are NOT the same thing. The
-- per-table sum covers the public schema; pg_database_size covers the
-- whole database, including auth, storage, realtime and the catalogue.
-- The plan's ceiling applies to the second one, so that is the figure
-- to compare against 8 GB.
select
  c.relname                                            as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid))        as total,
  pg_size_pretty(pg_relation_size(c.oid))              as heap,
  pg_size_pretty(pg_indexes_size(c.oid))               as indexes,
  pg_size_pretty(
    pg_total_relation_size(c.oid)
    - pg_relation_size(c.oid)
    - pg_indexes_size(c.oid))                          as toast,
  c.reltuples::bigint                                  as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc;

-- And the whole database, which is what the plan's ceiling applies to.
select pg_size_pretty(pg_database_size(current_database())) as database_total;
