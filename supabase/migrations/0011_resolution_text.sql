-- markets.resolution: what the venue says the market actually resolves on.
--
-- Every pair on this site is a claim that two markets on two exchanges
-- mean the same thing, and the reader has had no way to check it. The
-- econ pairs were each verified by hand against Kalshi's rules_primary
-- rather than its title, precisely because titles are not the contract
-- -- "Will Bitcoin be above $99,999.99" and "Will Bitcoin reach
-- $100,000" are the same market and read as different ones, while
-- "reach $100k by Dec 31" and "above $100k AT Dec 31" read as the same
-- market and are not. Storing the resolution text moves that check from
-- something only the matcher's author could do to something the person
-- risking money can do.
--
-- One venue-neutral column rather than three: Kalshi calls it
-- rules_primary, polymarket.com and polymarket.us both call it
-- description. All three were checked against the live APIs rather than
-- assumed -- see the note in CLAUDE.md about concluding what a venue
-- publishes from anything other than a real response.
--
-- Nullable, and it stays nullable. Discovery only refreshes what it
-- re-fetches, so rows populate as categories are re-run rather than all
-- at once, and a card must render with this absent -- which is also
-- what happens between this deploy and this migration being run by
-- hand.
--
-- Idempotent.

alter table markets add column if not exists resolution text;

-- get_pairs rebuilt to carry both legs' resolution text.
--
-- CREATE OR REPLACE VIEW-style column appends are not available to a
-- function returning a named record type: the return type changes, so
-- the old function has to go first. Dropping and recreating is the
-- documented pattern here (0006 did the same for the two views).
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
  p_resolution text
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
    pm.resolution
  from pairs p
  join markets k  on k.id  = p.kalshi_id
  join markets pm on pm.id = p.polymarket_id
  where k.sport_tag = any(sport_tags)
  order by p.similarity desc
$$ language sql security definer;
