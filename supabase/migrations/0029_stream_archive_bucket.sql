-- Private Storage bucket for the WebSocket recorder's archive
-- (scripts/m15-stream.mjs): hourly gzipped NDJSON of the 15-minute
-- markets' books, final-window order flow, trades and CF Benchmarks
-- index ticks.
--
-- WHY STORAGE AND NOT A TABLE. A day of it is millions of rows — several
-- times what the 15-second poller writes to m15_quotes — and nothing
-- queries it live. Files cost storage only; rows cost storage, indexes,
-- WAL and vacuum.
--
-- PRIVATE, AND IT MUST STAY PRIVATE. Kalshi's data terms allow personal
-- use and exclude "providing archived or cached data sets containing
-- Kalshi Data to another person". `public = false` and NO policies on
-- storage.objects for this bucket: anon and authenticated can neither
-- list nor read it, and only the service-role key (which bypasses RLS)
-- can write or download. Do not add a read policy.
--
-- Idempotent. Re-running it also forces the bucket back to private.

insert into storage.buckets (id, name, public)
values ('stream-archive', 'stream-archive', false)
on conflict (id) do update set public = false;

-- Verify (expect one row, public = false):
--   select id, public from storage.buckets where id = 'stream-archive';
