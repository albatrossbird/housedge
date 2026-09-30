-- Delete the 15-minute data OUTSIDE the research scope: everything but
-- Bitcoin (KXBTC15M) and gold (KXGOLD15M). Decided 2026-09-30.
--
-- IRREVERSIBLE FOR m15_quotes. The price path is recorded live and
-- cannot be fetched again; m15_markets rows could be re-backfilled from
-- Kalshi (settled markets stay queryable), m15_quotes rows cannot. Run
-- m15_scope_size.sql first and read what it says will go.
--
-- RUN OVER A DIRECT CONNECTION, NOT THE SQL EDITOR. The editor gives up
-- after ~60s, and this walks millions of rows. Session pooler (port
-- 5432), at a quiet hour — not 15:45-16:45 UTC, when discovery and
-- matching run:
--
--   psql "<session-pooler-url>" -v ON_ERROR_STOP=1 -f supabase/queries/m15_scope_prune.sql
--
-- It deletes m15_quotes in id-range batches of 50,000, committing each,
-- so the recorder's writes are never blocked for long and an interrupted
-- run keeps what it did. Safe to re-run: a second pass finds nothing.

set statement_timeout = 0;

-- 1. m15_quotes, in batches along the primary key.
do $$
declare
  lo bigint; hi bigint; cur bigint; n bigint; total bigint := 0;
begin
  select min(id), max(id) into lo, hi from m15_quotes;
  if lo is null then raise notice 'm15_quotes is empty'; return; end if;
  cur := lo;
  while cur <= hi loop
    delete from m15_quotes
     where id >= cur and id < cur + 50000
       and ticker not like 'KXBTC15M-%'
       and ticker not like 'KXGOLD15M-%';
    get diagnostics n = row_count;
    total := total + n;
    commit;
    cur := cur + 50000;
  end loop;
  raise notice 'm15_quotes: deleted % rows', total;
end $$;

-- 2. m15_markets (small).
delete from m15_markets where series not in ('KXBTC15M', 'KXGOLD15M');

-- 3. What is left.
select split_part(ticker, '-', 1) as series, count(*) from m15_quotes group by 1 order by 2 desc;

-- DELETE DOES NOT SHRINK THE TABLE. The space becomes reusable by new
-- rows (so growth stops until it is refilled), but the reported size
-- only falls on a rewrite. If the size itself matters, run this after,
-- still over the direct connection. It takes an EXCLUSIVE lock on
-- m15_quotes while it runs — the 15-second recorder's writes fail for
-- that stretch and it simply retries on its next tick — and needs free
-- disk about equal to what is left of the table:
--
--   vacuum (full, analyze) m15_quotes;
