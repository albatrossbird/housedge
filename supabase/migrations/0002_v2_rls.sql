-- Row Level Security for the v2 tables.
--
-- Run this AFTER 0001_v2_schema.sql. Idempotent — safe to re-run.
--
-- WHY (and why only v2):
--
-- The data here is public market odds, so confidentiality is not really
-- the concern. Integrity is: with RLS off, anyone holding the anon key
-- can DELETE. Most v2 tables are rebuildable by re-running ingest, but
-- `quotes` is not — it is an append-only record of prices at moments
-- that have passed, and nothing can reconstruct it. That single fact is
-- what makes write protection worth doing now rather than later.
--
-- Deliberately scoped to v2 tables only. The v1 `markets`/`pairs` tables
-- keep whatever posture they have today, so the live site's read path
-- and the existing /api/embed + /api/refresh writes cannot break while
-- the migration is in progress. When v1 is retired, this posture is
-- already the default.
--
-- HOW IT WORKS:
--
--   anon         -> SELECT only. Safe to expose; it is what a browser
--                   or a future public API would use.
--   service_role -> bypasses RLS entirely (Supabase built-in). All
--                   server-side writes use this key. It must only ever
--                   be read from server code — never a NEXT_PUBLIC_*
--                   var, never shipped to the browser.
--
-- REQUIRES: SUPABASE_SERVICE_ROLE_KEY set in the Vercel project env
-- (Supabase Dashboard -> Project Settings -> API -> service_role key).
-- Without it, writes to v2 tables will fail once this migration runs.
-- lib/v2/db.js falls back to the anon key and reports which credential
-- it used, so the failure is diagnosable rather than silent.

alter table events   enable row level security;
alter table outcomes enable row level security;
alter table listings enable row level security;
alter table quotes   enable row level security;
alter table venues   enable row level security;

-- Public read. Split per table so a future change (e.g. hiding
-- unmatched listings from public reads) only touches one policy.
drop policy if exists "public read events"   on events;
drop policy if exists "public read outcomes" on outcomes;
drop policy if exists "public read listings" on listings;
drop policy if exists "public read quotes"   on quotes;
drop policy if exists "public read venues"   on venues;

create policy "public read events"   on events   for select to anon, authenticated using (true);
create policy "public read outcomes" on outcomes for select to anon, authenticated using (true);
create policy "public read listings" on listings for select to anon, authenticated using (true);
create policy "public read quotes"   on quotes   for select to anon, authenticated using (true);
create policy "public read venues"   on venues   for select to anon, authenticated using (true);

-- No INSERT/UPDATE/DELETE policies for anon: with RLS enabled and no
-- write policy, those operations are refused regardless of grants.
-- Revoke the grants too — defense in depth, and it makes the intent
-- legible from \dp rather than only from the policy list.
revoke insert, update, delete on events, outcomes, listings, quotes, venues from anon;

-- Views run with the privileges of their owner and are not themselves
-- RLS-protected; they read the base tables, which are. Keeping SELECT
-- granted here means the public read path still works.
grant select on latest_quotes, v2_market_view to anon, authenticated;
