-- Executable pricing for v1: real books and the fee parameters needed
-- to price them.
--
-- v1 stored one mid price per side, so every arbitrage the site showed
-- was the edge available to someone trading at the midpoint on both
-- venues, paying no fees. Nobody trades there. This adds the two
-- missing inputs.
--
-- Idempotent: safe to re-run.

-- ── Books ──────────────────────────────────────────────────────
-- `bid`/`ask` is the book as the venue itself quotes it:
--   Kalshi     — the YES side of one binary ticker.
--   Polymarket — the market's own book, which is quoted on outcome 0.
--
-- `no_bid`/`no_ask` is Kalshi-only and deliberately so. A Kalshi binary
-- is tradable from both sides and its NO book is a genuinely separate
-- one — NOT 1 - yes. Polymarket runs a single binary CLOB per market,
-- where the other outcome IS the exact complement, so storing a second
-- book for it would be duplicating a derived value and inviting the two
-- copies to disagree. markets.js derives it at read time.
alter table markets add column if not exists bid          numeric;
alter table markets add column if not exists ask          numeric;
alter table markets add column if not exists no_bid       numeric;
alter table markets add column if not exists no_ask       numeric;

-- Depth at the touch. Not used by the arb maths yet, but an edge that
-- exists for 3 contracts is not the same finding as one that exists for
-- 3,000, and this is free to collect alongside the prices.
alter table markets add column if not exists bid_size     numeric;
alter table markets add column if not exists ask_size     numeric;

-- ── Fee parameters ─────────────────────────────────────────────
-- Stored per market rather than hardcoded in the fee model: both
-- venues publish these and both have changed them (Polymarket's sports
-- rate moved during 2026). A constant in code would go quietly stale in
-- exactly the way that produces confident wrong answers.
--
-- Kalshi: fee_multiplier is per-series, from /series/<ticker>.
-- Polymarket: fee_schedule is the market's own {rate, exponent,
-- takerOnly, rebateRate} object.
alter table markets add column if not exists fee_multiplier numeric;
alter table markets add column if not exists fee_schedule   jsonb;

-- ── Kalshi web URL ─────────────────────────────────────────────
-- Kalshi's market page is /markets/<series>/<event-slug>/<event-ticker>,
-- e.g. .../kxmlbgame/professional-baseball-game/kxmlbgame-26aug271910milnym.
-- The site links were built from the first segment alone, which is not
-- a route, so every one of them errored.
--
-- The middle segment is the series TITLE slugified, and the API returns
-- it on /series/<ticker> but nowhere on the market or event, so it has
-- to be fetched once per series and stored. The other two segments we
-- already have (id prefix, event_ticker).
alter table markets add column if not exists series_slug text;

-- ── get_pairs ──────────────────────────────────────────────────
-- The return type changes, and Postgres will not replace a function
-- whose OUT parameters differ — CREATE OR REPLACE fails with 42P13
-- ("cannot change return type of existing function"), the same trap
-- CREATE OR REPLACE VIEW hit in 0003. Drop first.
drop function if exists get_pairs(text[]);

create function get_pairs(sport_tags text[])
returns table (
  kalshi_id text, polymarket_id text, similarity float,
  k_title text, k_yes_price float, k_no_price float, k_volume float,
  k_sport_tag text, k_event_ticker text, k_side_label text, k_close_time text,
  k_bid numeric, k_ask numeric, k_no_bid numeric, k_no_ask numeric,
  k_fee_multiplier numeric, k_series_slug text,
  k_bid_size numeric, k_ask_size numeric,
  p_title text, p_yes_price float, p_no_price float, p_volume float,
  p_slug text, p_side_label text, p_outcomes text, p_outcome_prices text,
  p_bid numeric, p_ask numeric, p_fee_schedule jsonb
) as $$
  select p.kalshi_id, p.polymarket_id, p.similarity,
    k.title, k.yes_price, k.no_price, k.volume, k.sport_tag, k.event_ticker,
    k.side_label, k.close_time,
    k.bid, k.ask, k.no_bid, k.no_ask, k.fee_multiplier, k.series_slug,
    k.bid_size, k.ask_size,
    pm.title, pm.yes_price, pm.no_price, pm.volume, pm.slug, pm.side_label,
    pm.outcomes, pm.outcome_prices,
    pm.bid, pm.ask, pm.fee_schedule
  from pairs p
  join markets k  on k.id  = p.kalshi_id
  join markets pm on pm.id = p.polymarket_id
  where k.sport_tag = any(sport_tags)
  order by p.similarity desc
$$ language sql security definer;
