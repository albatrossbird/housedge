-- get_pairs: carry each leg's updated_at, so the site can say how old a
-- price actually is.
--
-- The header read "Updated 3:42 PM" off the browser's fetch clock, which
-- is a different fact from the one a reader needs: it says when the page
-- asked, not when the venue was last observed. Those are minutes apart in
-- the best case and hours apart in the normal one -- .github/workflows/
-- refresh-prices.yml asks for */15 and GitHub delivers 45 minutes to 3.5
-- hours on a public repo. So a price observed at noon renders under
-- "Updated 3:42 PM" and reads as current.
--
-- Everything else on the card is honest about its own uncertainty --
-- depthKnown, feesIncluded, a null ask where there is no executable
-- price. Price age was the one number presented as fresher than it is,
-- and it is the number a reader would act on.
--
-- Idempotent.

drop function if exists get_pairs(text[]);

create function get_pairs(sport_tags text[])
returns table (
  kalshi_id text, polymarket_id text, similarity float,
  k_title text, k_yes_price float, k_no_price float, k_volume float,
  k_sport_tag text, k_event_ticker text, k_side_label text, k_close_time text,
  k_bid numeric, k_ask numeric, k_no_bid numeric, k_no_ask numeric,
  k_fee_multiplier numeric, k_series_slug text,
  k_bid_size numeric, k_ask_size numeric, k_updated_at timestamptz,
  p_title text, p_yes_price float, p_no_price float, p_volume float,
  p_slug text, p_side_label text, p_outcomes text, p_outcome_prices text,
  p_platform text, p_bid_size numeric, p_ask_size numeric,
  p_bid numeric, p_ask numeric, p_fee_schedule jsonb, p_updated_at timestamptz
) as $$
  select p.kalshi_id, p.polymarket_id, p.similarity,
    k.title, k.yes_price, k.no_price, k.volume, k.sport_tag, k.event_ticker,
    k.side_label, k.close_time,
    k.bid, k.ask, k.no_bid, k.no_ask, k.fee_multiplier, k.series_slug,
    k.bid_size, k.ask_size, k.updated_at,
    pm.title, pm.yes_price, pm.no_price, pm.volume, pm.slug, pm.side_label,
    pm.outcomes, pm.outcome_prices,
    pm.platform, pm.bid_size, pm.ask_size,
    pm.bid, pm.ask, pm.fee_schedule, pm.updated_at
  from pairs p
  join markets k  on k.id  = p.kalshi_id
  join markets pm on pm.id = p.polymarket_id
  where k.sport_tag = any(sport_tags)
  order by p.similarity desc
$$ language sql security definer;
