-- get_pairs: return the pair's own id, and sort on it as a tiebreaker,
-- so the function can be PAGED.
--
-- SELF-CONTAINED, and supersedes 0012. Running this alone is enough.
--
-- Why. PostgREST caps a response at db-max-rows (1000 here) and that is
-- a SERVER-side maximum: a client `.limit()` can ask for fewer rows than
-- it, never more. Raising the limit to 20,000 left the response at
-- exactly 1000. The only way past it is to page with Range headers.
--
-- Paging needs a TOTAL order, and `order by p.similarity desc` alone is
-- not one — badly so here. Sports pairs are an exact join on the game
-- identifier, so every one carries similarity 1.0: hundreds of rows in a
-- single tie block. Postgres promises nothing about the order of tied
-- rows between two statements, so consecutive OFFSET pages can overlap
-- or SKIP rows outright. That is the same defect that let the embedding
-- read skip markets and buy them from Voyage a second time.
--
-- Two halves, and BOTH are needed:
--
--   * `p.id` in the ORDER BY makes the sort inside the function total.
--   * `pair_id` in the RETURNS TABLE lets the CALLER re-state that order
--     on the outer query (`order=similarity.desc,pair_id.asc`). Without
--     it the caller can only order by `similarity`, which is exactly the
--     untied sort the tiebreaker exists to fix — and an ORDER BY inside
--     a set-returning function is not guaranteed to survive into an
--     outer LIMIT/OFFSET query.
--
-- `similarity desc` still leads, so nothing about the existing ordering
-- changes and an unpaged caller sees what it saw before.

drop function if exists get_pairs(text[]);

create function get_pairs(sport_tags text[])
returns table (
  pair_id bigint,
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
  select p.id::bigint, p.kalshi_id, p.polymarket_id, p.similarity,
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
  order by p.similarity desc, p.id
$$ language sql security definer;
