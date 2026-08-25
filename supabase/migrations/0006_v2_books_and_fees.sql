-- v2: executable pricing, matching what v1 got in 0004/0005.
--
-- v2's arb calc reports `feesIncluded: false` and means it. Its quotes
-- were backfilled from v1 before v1 stored books, so they carry `mid`
-- only and the calc falls back to it — the same midpoint fiction v1 has
-- now shed. Kalshi and Polymarket both charge takers on a quadratic
-- curve, and on live pairs those costs are larger than most of the
-- edges being reported.
--
-- `quotes` already has bid/ask, so what is missing is (a) depth, which
-- varies per snapshot and belongs on the quote, and (b) the fee
-- parameters, which are per-instrument metadata and belong on the
-- listing.
--
-- Idempotent: safe to re-run.

-- Depth at the touch. Per-snapshot, so it lives with the quote.
-- The same Bitcoin strike family offered 7 contracts at one price and
-- 710 at another, which is the difference between six cents of profit
-- and fifteen dollars.
alter table quotes add column if not exists bid_size numeric;
alter table quotes add column if not exists ask_size numeric;

-- Fee parameters. Per-instrument and near-static, so they live with the
-- listing rather than being repeated on every quote row — `quotes` is
-- the one table that grows without bound.
--
-- Read from each venue's API, never hardcoded: Kalshi's multiplier is
-- per-series on /series/<ticker>, Polymarket's schedule is on the
-- market, and Polymarket changed its rates mid-2026.
alter table listings add column if not exists fee_multiplier numeric;
alter table listings add column if not exists fee_schedule   jsonb;

-- ── Views ──────────────────────────────────────────────────────
-- Both must be DROPped, not replaced: CREATE OR REPLACE VIEW can only
-- append columns, and these insert them mid-list. That is the 42P16
-- "cannot change name of view column" trap 0003 hit.
--
-- v2_market_view depends on latest_quotes, so drop the dependent first
-- and recreate in the reverse order.
drop view if exists v2_market_view;
drop view if exists latest_quotes;

create view latest_quotes as
select distinct on (listing_id)
  listing_id, ts, bid, ask, mid, last, volume, bid_size, ask_size
from quotes
order by listing_id, ts desc;

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
  l.fee_multiplier,
  l.fee_schedule,
  q.bid, q.ask, q.mid, q.last, q.volume,
  q.bid_size, q.ask_size,
  q.ts                as quoted_at
from events e
join outcomes o  on o.event_id = e.id
join listings l  on l.outcome_id = o.id
left join latest_quotes q on q.listing_id = l.id;
