-- Which recorder wrote this weather row?
--
-- THE SAME QUESTION 0023 ADDED FOR m15, for the same cutover. The
-- weather recorder is moving from GitHub Actions to the box, and for a
-- couple of days both will be writing. The overlap is safe — wx_quotes
-- is append-only and write-on-change, so two recorders cost duplicate
-- rows and never a gap — but it makes the only question worth asking
-- unanswerable:
--
--   can the Actions recorder be turned off?
--
-- Union coverage cannot answer it. Two recorders together covering
-- every hour reads identically whether the box covered all of them or
-- half. Turning Actions off on a union figure risks learning the
-- difference through a week of lost forecast and book, and neither half
-- is backfillable: a settled Kalshi market reports one last price, and
-- NWS serves the CURRENT forecast, never the one it was issuing
-- yesterday afternoon.
--
-- WHY NOT wx_forecasts TOO. That table ALREADY has a `source` column
-- and it means something else — the forecast PROVIDER ('nws'), not the
-- process that recorded it. Adding recorder attribution there would
-- either collide with a live column or introduce a second name for one
-- concept across two tables. It is also unnecessary: forecasts are
-- written from inside the same loop as quotes, on a 60-minute
-- sub-clock, so a recorder that covers the hours covers both. Read
-- wx_quotes for coverage and wx_forecasts for content.
--
-- WHY NOT wx_markets. It is upserted on ticker, so a source column
-- there would record whichever recorder wrote last, not who was
-- running — a value that looks like attribution and is not.
--
-- WHY NULLABLE, AND WHY NO BACKFILL. Every existing row was written by
-- Actions, so the honest value for them is "before this column existed"
-- rather than a guess stamped across the table. NULL says that. An
-- UPDATE over the whole table would also take a lock on a table a live
-- recorder is appending to, to record something observed_at implies.
--
-- Idempotent, like every migration here.

alter table wx_quotes add column if not exists source text;

-- The comparison this exists for: hours covered, per source. Without
-- this the query is a sequential scan over the whole price path.
create index if not exists wx_quotes_source_observed_idx
  on wx_quotes (source, observed_at desc);

comment on column wx_quotes.source is
  'Recorder that wrote the row: ''actions'', ''box'', or NULL for rows predating the column (all of which were written by the Actions recorder). Distinct from wx_forecasts.source, which names the forecast provider.';
