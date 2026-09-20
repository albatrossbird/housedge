-- What the box says about itself, so nobody has to SSH in to ask.
--
-- WHY THIS EXISTS. Everything this project records is market data; the
-- machine recording it was observable only by logging in. Over three
-- days that meant a human at a terminal for every question worth
-- asking — is it running the latest code, did the unit restart, what
-- did it say when it failed — and one of those questions went unasked
-- for fourteen hours while a recorder wrote nothing and warned about
-- it every fifteen seconds.
--
-- ONE ROW PER HOST, UPSERTED. This is current state, not a time series.
-- A box that stops reporting leaves its row behind with an old
-- `reported_at`, which is exactly the signal wanted: the watchdog reads
-- staleness here the same way it reads it on every other table, so a
-- dead box and a dead recorder are found the same way.
--
-- The alternative, appending, would grow without bound to answer a
-- question ("what is it doing now") that only ever needs one row, and
-- the journal on the box is already the history.
--
-- Idempotent, like every migration here.

create table if not exists box_health (
  host          text primary key,
  reported_at   timestamptz not null default now(),
  -- The commit the box is actually running, which is the question
  -- `git log` on the box used to answer. A box behind main is the
  -- normal state for up to ten minutes and a bug after that.
  git_sha       text,
  git_branch    text,
  -- Per-unit: active/failed/inactive, plus restart count, because a
  -- unit that is "active" having restarted forty times is not healthy
  -- and reads identically to one that has not.
  units         jsonb,
  -- Recent error/warning lines, already truncated. Enough to recognise
  -- a failure without being a log shipper.
  recent_errors text[],
  disk_pct      integer,
  mem_used_mb   integer,
  uptime_seconds bigint
);

alter table box_health enable row level security;

drop policy if exists "public read box_health" on box_health;
create policy "public read box_health" on box_health
  for select to anon, authenticated using (true);

revoke insert, update, delete on box_health from anon;

comment on table box_health is
  'Self-reported state of each recorder host, upserted every few minutes. Staleness of reported_at means the host stopped reporting.';
