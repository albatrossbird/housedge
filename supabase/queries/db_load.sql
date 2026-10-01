-- What is the database busy with RIGHT NOW? Read-only.
--
-- For when the site's API, the watchdog and Storage listings all time
-- out at once (57014, Storage's 544 DatabaseTimeout) and nothing was run
-- by hand. Catalogue reads only, so it answers even on a loaded
-- database — though if the SQL editor itself times out, that is an
-- answer too. Check Observability -> Database Health -> Disk IO budget
-- alongside it: a spent budget throttles every query and shows here as
-- many statements waiting on IO rather than one obvious culprit.

-- 1. Every non-idle connection, longest-running first.
select pid,
       usename,
       application_name,
       client_addr,
       state,
       wait_event_type,
       wait_event,
       now() - query_start as running_for,
       now() - xact_start  as in_transaction_for,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) as query
from pg_stat_activity
where state <> 'idle'
  and pid <> pg_backend_pid()
order by query_start nulls last;

-- 2. Connections by state, against the ceiling.
select state, count(*) as connections,
       (select setting::int from pg_settings where name = 'max_connections') as max_connections
from pg_stat_activity
group by state
order by connections desc;

-- 3. Is autovacuum running, and on what? A vacuum of a large table is
--    heavy IO that nobody started by hand.
select pid, now() - xact_start as running_for, left(query, 120) as query
from pg_stat_activity
where query ilike 'autovacuum:%';

-- 4. The tables taking writes, and their dead rows. Heavy churn with
--    many dead tuples is what drives autovacuum (3) and IO.
select relname,
       n_live_tup,
       n_dead_tup,
       n_tup_ins, n_tup_upd, n_tup_del,
       last_autovacuum,
       last_autoanalyze
from pg_stat_user_tables
order by n_tup_ins + n_tup_upd + n_tup_del desc
limit 10;
