-- get_pairs: say WHICH Polymarket a pair belongs to, and carry its depth.
--
-- polymarket.com and polymarket.us are different exchanges with
-- different books, and a US account can only trade the .us one. With
-- both now stored in `markets`, a pair that does not name its venue is
-- ambiguous: the site cannot build the right link, label the right
-- exchange, or tell the reader whether the edge is one they can take.
--
-- Polymarket US also publishes depth (bidDepth/askDepth from its /bbo
-- endpoint), which polymarket.com does not, so p_bid_size/p_ask_size
-- come through as well — that makes a US pair the first one whose size
-- is known on BOTH legs rather than bounded by Kalshi alone.
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
  k_bid_size numeric, k_ask_size numeric,
  p_title text, p_yes_price float, p_no_price float, p_volume float,
  p_slug text, p_side_label text, p_outcomes text, p_outcome_prices text,
  p_platform text, p_bid_size numeric, p_ask_size numeric,
  p_bid numeric, p_ask numeric, p_fee_schedule jsonb
) as $$
  select p.kalshi_id, p.polymarket_id, p.similarity,
    k.title, k.yes_price, k.no_price, k.volume, k.sport_tag, k.event_ticker,
    k.side_label, k.close_time,
    k.bid, k.ask, k.no_bid, k.no_ask, k.fee_multiplier, k.series_slug,
    k.bid_size, k.ask_size,
    pm.title, pm.yes_price, pm.no_price, pm.volume, pm.slug, pm.side_label,
    pm.outcomes, pm.outcome_prices,
    pm.platform, pm.bid_size, pm.ask_size,
    pm.bid, pm.ask, pm.fee_schedule
  from pairs p
  join markets k  on k.id  = p.kalshi_id
  join markets pm on pm.id = p.polymarket_id
  where k.sport_tag = any(sport_tags)
  order by p.similarity desc
$$ language sql security definer;
