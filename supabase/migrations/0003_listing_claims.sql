-- Persist LLM-extracted resolution claims on listings.
--
-- Run in the Supabase SQL editor after 0002. Idempotent.
--
-- WHY ON LISTINGS, not outcomes: a claim is a property of what a
-- specific venue's title asserts. Outcomes are canonical and derived —
-- they get their claim from whichever listings were matched into them.
-- Extraction happens per title, so the claim lands where the title is.
--
-- claim_title_hash is the caching key that makes this affordable. Market
-- titles are stable, so a title whose hash is unchanged never needs
-- re-extraction — you pay once per unique title, ever. Sports is the
-- exception that motivated the design: every game is a new title, so
-- without a hash check a nightly job would re-bill the entire catalog.
-- (The intended long-term split is a template parser handling sports and
-- the LLM as fallback; the hash is what keeps the fallback cheap.)

alter table listings
  add column if not exists claim_subject        text,
  add column if not exists claim_metric_type    text,
  add column if not exists claim_unit           text,
  add column if not exists claim_op             text,
  add column if not exists claim_value          numeric,
  add column if not exists claim_low            numeric,
  add column if not exists claim_high           numeric,
  add column if not exists claim_period_year    int,
  add column if not exists claim_period_quarter int,
  add column if not exists claim_period_month   int,
  add column if not exists claim_region         text,
  add column if not exists claim_side           text,
  add column if not exists claim_confidence     numeric,
  -- provenance: which model produced this, when, and for what title.
  add column if not exists claim_model          text,
  add column if not exists claim_extracted_at   timestamptz,
  add column if not exists claim_title_hash     text;

-- Finding work: listings that have no claim yet.
create index if not exists listings_needs_claim_idx
  on listings (category)
  where claim_title_hash is null;

-- Matching reads claims by category + venue.
create index if not exists listings_claim_lookup_idx
  on listings (category, venue_id)
  where claim_title_hash is not null;

-- Surface claims on the read path so the UI can show *why* two listings
-- were considered the same market, not just that they were.
--
-- DROP then CREATE, not CREATE OR REPLACE: replace can only append
-- columns at the end of an existing view, and these claim columns sit
-- before the quote columns, so replace fails with
-- "cannot change name of view column \"bid\" to \"claim_subject\"".
-- Nothing but our own API route reads this view, so dropping is safe —
-- but the grant below must be re-applied, since dropping takes it too.
drop view if exists v2_market_view;

create view v2_market_view as
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
  l.claim_subject,
  l.claim_metric_type,
  l.claim_unit        as listing_claim_unit,
  l.claim_op          as listing_claim_op,
  l.claim_value       as listing_claim_value,
  l.claim_region,
  l.claim_confidence,
  l.claim_model,
  q.bid, q.ask, q.mid, q.last, q.volume,
  q.ts                as quoted_at
from events e
join outcomes o  on o.event_id = e.id
join listings l  on l.outcome_id = o.id
left join latest_quotes q on q.listing_id = l.id;

grant select on v2_market_view to anon, authenticated;
