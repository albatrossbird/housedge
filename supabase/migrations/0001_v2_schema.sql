-- Housedge v2 schema: canonical events -> outcomes -> listings -> quotes
--
-- See docs/architecture-v2.md for the reasoning. Summary: the v1 model
-- (markets + pairs(kalshi_id, polymarket_id)) names its two platforms in
-- its columns, represents price as binary yes/no columns, and has no
-- canonical record, so it cannot express a third venue, a 4-way market,
-- or a consistent "these are all the same market" fact.
--
-- This migration is ADDITIVE. It does not touch `markets` or `pairs`, so
-- the live site keeps working on the v1 read path while v2 is backfilled
-- and validated. Dropping v1 tables is a separate, later migration.
--
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- It is idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────
-- venues
-- ─────────────────────────────────────────────────────────────
create table if not exists venues (
  id          text primary key,           -- 'kalshi', 'polymarket', 'manifold', ...
  name        text not null,
  created_at  timestamptz not null default now()
);

insert into venues (id, name) values
  ('kalshi',     'Kalshi'),
  ('polymarket', 'Polymarket')
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- events — canonical, platform-agnostic
--
-- One row per real-world question, independent of who lists it.
-- Identity is the resolution criteria, not the title: subject +
-- period + resolution source. Two venues listing the same question
-- point at the same event row.
-- ─────────────────────────────────────────────────────────────
create table if not exists events (
  id                uuid primary key default gen_random_uuid(),
  -- Deterministic natural key so ingestion/backfill is idempotent:
  -- re-running must update the same event, not create a second one.
  -- e.g. 'v1pair:KXGDP-26SEP30-T3.0'
  source_key        text unique,
  category          text not null,        -- 'econ','mlb','nba','nhl','soccer','crypto','politics'
  subject           text not null,        -- normalized underlying, e.g. 'us_real_gdp_growth_qoq'
  title             text,                 -- human-readable canonical title
  -- resolution period. quarter is null for annual/one-off questions.
  period_year       int,
  period_quarter    int,
  resolution_date   timestamptz,
  resolution_source text,                 -- 'BEA advance estimate', 'official game result', ...
  region            text default 'US',    -- 'US','UK','EU',... — a first-class field, not a
                                          -- regex over the title (see v1 pitfalls)
  -- true when the outcome set is mutually exclusive AND exhaustive.
  -- Cross-venue arb (sum of best asks < 1) is only valid when true.
  outcomes_exhaustive boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists events_category_idx on events (category);
create index if not exists events_subject_idx  on events (subject);
create index if not exists events_period_idx   on events (period_year, period_quarter);

-- ─────────────────────────────────────────────────────────────
-- outcomes — the mutually exclusive set within one event
--
-- Binary markets have exactly 2 rows (yes/no); a 3-way soccer match has
-- 3; a Fed decision can have many. This is what makes multi-outcome
-- native instead of a special case.
--
-- The claim_* columns are the structured resolution claim that v1's
-- extractNumericClaim() produces. Storing them makes the matching gate a
-- column comparison instead of re-parsing titles, and makes synthetic
-- combinations (a threshold contract == the union of bucket outcomes)
-- derivable in SQL.
-- ─────────────────────────────────────────────────────────────
create table if not exists outcomes (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  label       text not null,              -- 'Above 3.0%', 'Yankees', 'Draw'
  claim_unit  text,                       -- 'percent' | 'bps' | 'count' | 'usd' | null
  claim_op    text,                       -- 'gt'|'gte'|'lt'|'lte'|'range'|'eq'|'winner'
  claim_value numeric,                    -- for scalar ops
  claim_low   numeric,                    -- for 'range'
  claim_high  numeric,                    -- for 'range'
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  -- same idempotency reasoning as events.source_key
  unique (event_id, label)
);

create index if not exists outcomes_event_idx on outcomes (event_id);
create index if not exists outcomes_claim_idx on outcomes (claim_unit, claim_op, claim_value);

-- ─────────────────────────────────────────────────────────────
-- listings — one venue's tradable instrument for one outcome
--
-- outcome_id is NULLABLE on purpose: a freshly ingested listing that
-- hasn't been matched yet is a valid state, and unmatched listings are
-- exactly what the review queue works through. Never drop a listing just
-- because it has no canonical home yet.
-- ─────────────────────────────────────────────────────────────
create table if not exists listings (
  id               uuid primary key default gen_random_uuid(),
  venue_id         text not null references venues(id),
  venue_market_id  text not null,         -- kalshi ticker / polymarket numeric id
  -- Which side of the venue instrument this row represents. One Kalshi
  -- binary ticker is tradable from both sides, and its no-side has its
  -- own bid/ask (NOT simply 1 - yes, there is a spread), so each side
  -- gets its own listing and its own quote stream.
  side             text not null default 'yes',   -- 'yes' | 'no'
  outcome_id       uuid references outcomes(id) on delete set null,
  title            text not null,
  side_label       text,                  -- kalshi yes_sub_title / poly groupItemTitle
  url              text,
  category         text,                  -- denormalized for filtering pre-match
  status           text not null default 'open',   -- 'open' | 'closed' | 'settled'
  embedding        jsonb,                 -- swap to vector(N) when pgvector is enabled
  raw              jsonb,                 -- untouched venue payload, for reprocessing
  -- match provenance: how this listing got attached to its outcome.
  -- Auditable by design — a wrong match is worse than a missing one.
  match_method     text,                  -- 'deterministic'|'embedding'|'llm'|'manual'
  match_confidence numeric,
  match_decided_at timestamptz,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  unique (venue_id, venue_market_id, side)
);

create index if not exists listings_outcome_idx  on listings (outcome_id);
create index if not exists listings_venue_idx    on listings (venue_id);
create index if not exists listings_category_idx on listings (category);
create index if not exists listings_unmatched_idx on listings (category)
  where outcome_id is null;

-- ─────────────────────────────────────────────────────────────
-- quotes — append-only price time series
--
-- v1 overwrote price in place, so there is no history and none can be
-- reconstructed. This is the one thing that cannot be backfilled later,
-- which is why it ships with the schema change rather than after it.
--
-- Store executable prices (bid/ask), not just a blended mid: arb is
-- computed against what you can actually transact at. `mid` is kept as a
-- convenience for charting.
--
-- GROWTH CONTROL: writers must only insert when something actually
-- changed (see recordQuotes() in lib/v2/quotes.js). At ~300 listings,
-- write-on-change keeps this in the low tens of MB rather than filling
-- the 500MB free tier in about two months of unconditional 5-minute
-- polling.
-- ─────────────────────────────────────────────────────────────
create table if not exists quotes (
  id         bigserial primary key,
  listing_id uuid not null references listings(id) on delete cascade,
  ts         timestamptz not null default now(),
  bid        numeric,
  ask        numeric,
  mid        numeric,
  last       numeric,
  volume     numeric
);

create index if not exists quotes_listing_ts_idx on quotes (listing_id, ts desc);
create index if not exists quotes_ts_idx         on quotes (ts);

-- Latest quote per listing. DISTINCT ON is the efficient form here and
-- uses quotes_listing_ts_idx directly; a naive max(ts) subquery per row
-- would not.
create or replace view latest_quotes as
select distinct on (listing_id)
  listing_id, ts, bid, ask, mid, last, volume
from quotes
order by listing_id, ts desc;

-- ─────────────────────────────────────────────────────────────
-- Read path: one row per (event, outcome, venue) with current price.
--
-- The frontend groups by event_id, then outcome_id, and renders each
-- venue's price side by side. This replaces get_pairs() and is not
-- limited to two venues or two outcomes.
-- ─────────────────────────────────────────────────────────────
create or replace view v2_market_view as
select
  e.id                as event_id,
  e.category,
  e.title             as event_title,
  e.subject,
  e.region,
  e.period_year,
  e.period_quarter,
  e.resolution_date,
  e.outcomes_exhaustive,
  o.id                as outcome_id,
  o.label             as outcome_label,
  o.claim_unit,
  o.claim_op,
  o.claim_value,
  o.sort_order,
  l.id                as listing_id,
  l.venue_id,
  l.venue_market_id,
  l.side,
  l.title             as listing_title,
  l.url,
  l.status,
  l.match_method,
  l.match_confidence,
  q.bid, q.ask, q.mid, q.last, q.volume,
  q.ts                as quoted_at
from events e
join outcomes o  on o.event_id = e.id
join listings l  on l.outcome_id = o.id
left join latest_quotes q on q.listing_id = l.id;

-- ─────────────────────────────────────────────────────────────
-- Grants. The app connects with the anon key via PostgREST.
-- RLS is left disabled here to match the v1 tables' existing posture;
-- revisit before this data is user-scoped or writable from the browser.
-- ─────────────────────────────────────────────────────────────
grant select on venues, events, outcomes, listings, quotes to anon, authenticated;
grant select on latest_quotes, v2_market_view              to anon, authenticated;
grant insert, update, delete on venues, events, outcomes, listings, quotes to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
