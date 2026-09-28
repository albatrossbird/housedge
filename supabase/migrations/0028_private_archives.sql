-- Close anon read on the recorded archives.
--
-- WHY. Every table below was created readable by anyone holding the
-- anon key — `create policy ... for select using (true)` in 0016 and
-- 0021. That key is NOT shipped to browsers here (every Supabase client
-- is server-side; there is no NEXT_PUBLIC_ key), so the archive was never
-- open to the public. A first draft of this comment said it was, without
-- checking. But Supabase designs the anon key to be publishable, so one
-- change — a client-side read, a leaked secret — would expose the whole
-- recorded 15-minute and weather archive, which reads closely on Kalshi's
-- Data Terms of Use:
--
--   "providing archived or cached data sets containing Kalshi Data to
--    another person or entity"
--
-- is excluded from permitted use without Kalshi's written consent, and
-- "compiling ... databases" and "publicly displaying" are listed among
-- prohibited uses. The site itself never reads these tables — checked:
-- nothing under pages/ references them — so nothing a visitor sees
-- changes. The only readers are this repo's own analysis jobs, which
-- move to the service-role key in the same change.
--
-- WHY BOTH HALVES. Dropping the policy alone is the dangerous version.
-- With RLS on and no policy, an anon SELECT is not refused — it returns
-- ZERO ROWS with a 200. Every analysis job still on the anon key would
-- then report "no data" rather than fail, which is the silent no-op this
-- project has been bitten by more than any other bug. Revoking the grant
-- as well turns that into `42501 permission denied`, which the scripts
-- already throw on. A read that cannot see the table must say so.
--
-- service_role bypasses RLS and is granted explicitly so the intent is
-- on the page rather than inherited from a default.
--
-- NOT TOUCHED: `markets` and `pairs` — the site reads those with the anon
-- key on every page load — and `box_health`, which holds this project's
-- own machine state rather than Kalshi data.
--
-- A NEW TABLE IS PUBLIC BY DEFAULT. Supabase's default privileges grant
-- anon on every table created in `public`, so anything added later that
-- holds Kalshi data needs the same revoke in its own migration.
--
-- Verify after running — every row should read false:
--
--   select t, has_table_privilege('anon', t, 'select') as anon_can_read
--   from unnest(array['m15_markets','m15_quotes','wx_markets','wx_quotes','wx_forecasts']) t;
--
-- Idempotent, like every migration here.

drop policy if exists m15_markets_read  on m15_markets;
drop policy if exists m15_quotes_read   on m15_quotes;
drop policy if exists wx_markets_read   on wx_markets;
drop policy if exists wx_quotes_read    on wx_quotes;
drop policy if exists wx_forecasts_read on wx_forecasts;

revoke select on m15_markets, m15_quotes, wx_markets, wx_quotes, wx_forecasts
  from anon, authenticated;

grant select, insert, update, delete
  on m15_markets, m15_quotes, wx_markets, wx_quotes, wx_forecasts
  to service_role;
