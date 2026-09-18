-- Which recorder wrote this row?
--
-- WHY IT IS NEEDED NOW. The 15-minute recorder is moving from GitHub
-- Actions to a VPS, and for a couple of days BOTH will be writing. That
-- overlap is safe by design — m15_quotes is append-only and
-- write-on-change, so two recorders cost duplicate rows and never a gap
-- — but it makes the one question worth asking unanswerable:
--
--   can the Actions recorder be turned off?
--
-- Union coverage cannot answer it. If the two together cover 100% of
-- windows, that is equally consistent with the box covering 100% and
-- with each covering half. Turning Actions off on the strength of a
-- union figure risks discovering the difference through a week of lost
-- price path, which is the one asset here that cannot be backfilled.
--
-- WHY NULLABLE, AND WHY NO BACKFILL. Every existing row was written by
-- Actions, so the honest value for them is "before this column existed"
-- rather than a guess stamped across millions of rows. NULL says that.
-- An UPDATE over the whole table would also rewrite every row and take
-- a lock on a table two live recorders are appending to, to record
-- something the observed_at already implies.
--
-- Idempotent, like every migration here.

alter table m15_quotes add column if not exists source text;

-- The comparison this exists for: windows covered, per source, per day.
-- Without this the query is a sequential scan over the whole path.
create index if not exists m15_quotes_source_observed_idx
  on m15_quotes (source, observed_at desc);

comment on column m15_quotes.source is
  'Recorder that wrote the row: ''actions'', ''box'', or NULL for rows predating the column (all of which were written by the Actions recorder).';
