-- get_pairs: carry the Polymarket leg's event_ticker.
--
-- SELF-CONTAINED, and supersedes 0011. Running this alone is enough;
-- running it after 0011 is a no-op plus one extra column. Both halves
-- are idempotent.
--
-- Why: a polymarket.us market is addressed on the web by its PARENT
-- EVENT, not by itself.
--
--   /event/gdpc-us-saa-q3-2026-10-29-gt2pt0                    404
--   /event/us-saa-q3-2026-10-29?marketSlug=gdpc-...-gt2pt0     the market
--
-- and the event slug cannot be derived from the market slug: the family
-- prefix varies in length (gdpc, cpc, enwc, nphc, ushsscc, pnwpc, rdc,
-- vtc) and "cpc-btc-100k-10-31-2026" belongs to the event "btc-100k",
-- which drops the date entirely. So it is fetched from
-- /v1/events?closed=false and stored, and get_pairs has to return it or
-- every non-sports .us link stays a not-found page.
--
-- It goes in event_ticker, which already exists and already holds
-- exactly this for the Kalshi side.

alter table markets add column if not exists resolution text;

drop function if exists get_pairs(text[]);

create function get_pairs(sport_tags text[])
returns table (
  kalshi_id text, polymarket_id text, similarity float,
  k_title text, k_yes_price float, k_no_price float, k_volume float,
  k_sport_tag text, k_event_ticker text, k_side_label text, k_close_time text,
  k_bid numeric, k_ask numeric, k_no_bid numeric, k_no_ask numeric,
  k_fee_multiplier numeric, k_series_slug text,
  k_bid_size numeric, k_ask_size numeric, k_updated_at bigint,
  k_resolution text,
  p_title text, p_yes_price float, p_no_price float, p_volume float,
  p_slug text, p_side_label text, p_outcomes text, p_outcome_prices text,
  p_platform text, p_bid_size numeric, p_ask_size numeric,
  p_bid numeric, p_ask numeric, p_fee_schedule jsonb, p_updated_at bigint,
  p_resolution text, p_event_ticker text
) as $$
  select p.kalshi_id, p.polymarket_id, p.similarity,
    k.title, k.yes_price, k.no_price, k.volume, k.sport_tag, k.event_ticker,
    k.side_label, k.close_time,
    k.bid, k.ask, k.no_bid, k.no_ask, k.fee_multiplier, k.series_slug,
    k.bid_size, k.ask_size, k.updated_at,
    k.resolution,
    pm.title, pm.yes_price, pm.no_price, pm.volume, pm.slug, pm.side_label,
    pm.outcomes, pm.outcome_prices,
    pm.platform, pm.bid_size, pm.ask_size,
    pm.bid, pm.ask, pm.fee_schedule, pm.updated_at,
    pm.resolution, pm.event_ticker
  from pairs p
  join markets k  on k.id  = p.kalshi_id
  join markets pm on pm.id = p.polymarket_id
  where k.sport_tag = any(sport_tags)
  order by p.similarity desc
$$ language sql security definer;
