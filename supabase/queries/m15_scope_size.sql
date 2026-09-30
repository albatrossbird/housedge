-- How much of the 15-minute data is OUTSIDE the research scope
-- (Bitcoin and gold, lib/m15.js M15_RESEARCH_SERIES), before deleting
-- any of it. Read-only.
--
-- Cheap enough for the SQL editor: the first query is a catalogue read,
-- and the second samples 1% of m15_quotes' pages rather than scanning
-- the table (x100 gives an estimate, which is all a keep-or-delete
-- decision needs).

-- 1. On-disk size of each m15 table.
select c.relname                                     as table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_size_pretty(pg_indexes_size(c.oid))        as indexes,
       c.reltuples::bigint                           as approx_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'm15\_%'
order by pg_total_relation_size(c.oid) desc;

-- 2. m15_quotes rows by series, estimated from a 1% sample, with the
--    share that would go.
with s as (
  select split_part(ticker, '-', 1) as series, count(*) * 100 as est_rows
  from m15_quotes tablesample system (1)
  group by 1
)
select series, est_rows,
       round(100.0 * est_rows / sum(est_rows) over (), 1) as pct,
       case when series in ('KXBTC15M', 'KXGOLD15M') then 'keep' else 'delete' end as fate
from s order by est_rows desc;
