-- get_pairs: return the depth at the touch.
--
-- 0004 added bid_size/ask_size to `markets` but did not return them, so
-- the arb calculation had no way to ask how many contracts an edge was
-- good for. On live Kalshi books the same family of Bitcoin strikes
-- offered 7 contracts at one price and 710 at another — six cents of
-- profit versus fifteen dollars — so an edge without a size is not a
-- finding.
--
-- 0004 is updated too, so a fresh install gets this in one pass. This
-- file exists for installs that already ran it. Both are idempotent.

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
