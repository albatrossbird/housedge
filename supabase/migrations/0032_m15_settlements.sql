-- The price every 15-minute window settled at, exactly as Kalshi
-- reports it: `expiration_value` on a settled market, beside its
-- `floor_strike` (the price to beat, which is the previous window's
-- settlement). For the commodity and FX series that is the Pyth price
-- itself, at every window close, for free.
--
-- WHY. It is the yardstick for any cheaper feed that stands in for Pyth
-- (scripts/dukascopy-fetch.mjs compares one): a proxy is worth what it
-- says about these numbers. Pyth's own API needs a paid key since
-- 2026-08-26, and Kalshi's Pyth feed is $1,000 a month.
--
-- A TABLE OF ITS OWN, not a column on m15_markets. m15_markets holds
-- only the recorded series (lib/m15.js M15_RESEARCH_SERIES), and several
-- readers count every window in it — m15-coverage.mjs uses it as the
-- denominator — so adding nine more series there would move their
-- numbers without anything having changed.
--
-- KALSHI LISTS ONLY THE LAST ~10 WEEKS of settled markets (measured
-- 2026-10-26: KXBTC15M's oldest is 2026-08-19, 6,461 windows), so this
-- table is what keeps them once they roll off: each day it is not run is
-- a day lost at the far end. ~45,000 rows on the first run, ~1,000 a
-- day after. Written by scripts/m15-backfill.mjs.
--
-- PRIVATE, like every recorded table here (migration 0028): RLS on, no
-- policies, SELECT revoked from anon and authenticated, in the same
-- migration that creates it.
--
-- Idempotent.

create table if not exists m15_settlements (
  ticker      text primary key,
  series      text not null,
  close_time  timestamptz not null,
  strike      double precision,              -- floor_strike: the price to beat
  value       double precision not null,     -- expiration_value: the settlement price
  result      text,                          -- 'yes' | 'no'
  updated_at  timestamptz not null default now()
);

create index if not exists m15_settlements_series_close_idx on m15_settlements (series, close_time);

alter table m15_settlements enable row level security;
revoke all on m15_settlements from anon, authenticated;
