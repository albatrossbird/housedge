-- Kalshi 15-minute markets: settled history + a live quote path.
--
-- WHY TWO TABLES, AND WHY ONLY ONE OF THEM CAN BE BACKFILLED.
--
-- Kalshi lists exactly ONE open market per 15-minute series at a time,
-- and it lives for fifteen minutes. Two consequences decide this schema:
--
--   1. The OUTCOME is not perishable. Settled markets stay queryable
--      with their `result` — 6,458 of them for KXBTC15M alone, back to
--      2026-06-30 — so `m15_markets` can be filled in from history on
--      day one rather than accruing in wall-clock time.
--   2. The PRICE PATH is perishable. A settled market reports only its
--      last price, so "what was this quoted at with seven minutes left"
--      exists nowhere unless something was watching. That is the whole
--      reason `m15_quotes` exists, and why starting it early is worth
--      more than any analysis written against it later.
--
-- Idempotent, like every migration here.

create table if not exists m15_markets (
  ticker        text primary key,
  series        text not null,
  event_ticker  text,
  title         text,
  -- The reference the market resolves against ("Target Price"), which
  -- is set when the window opens.
  strike        double precision,
  open_time     timestamptz,
  close_time    timestamptz,
  -- null while the window is live; 'yes'/'no' once Kalshi settles it.
  result        text,
  last_price    double precision,
  volume        double precision,
  open_interest double precision,
  updated_at    timestamptz not null default now()
);

create index if not exists m15_markets_series_close_idx on m15_markets (series, close_time desc);
-- The backtest's main scan: settled windows in time order.
create index if not exists m15_markets_result_idx on m15_markets (close_time desc) where result is not null;

-- Append-only, write-on-change. An unconditional row every 15 seconds
-- across 26 series would be ~150k rows/day recording mostly duplicates;
-- storing only what moved keeps the path without the padding. The same
-- rule v2's `quotes` already uses, for the same reason.
create table if not exists m15_quotes (
  id          bigserial primary key,
  ticker      text not null,
  observed_at timestamptz not null default now(),
  -- Seconds remaining when observed. Derivable from close_time, stored
  -- because every query about a 15-minute market asks "how late was
  -- this" and computing it per row over millions is the slow way.
  secs_to_close integer,
  yes_bid     double precision,
  yes_ask     double precision,
  bid_size    double precision,
  ask_size    double precision,
  volume      double precision
);

create index if not exists m15_quotes_ticker_idx on m15_quotes (ticker, observed_at);
create index if not exists m15_quotes_observed_idx on m15_quotes (observed_at desc);

alter table m15_markets enable row level security;
alter table m15_quotes  enable row level security;

-- Anon reads, service-role writes — the v2 posture, not v1's. The
-- recorder runs in GitHub Actions with the service-role key; nothing
-- public writes here.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'm15_markets' and policyname = 'm15_markets_read') then
    create policy m15_markets_read on m15_markets for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'm15_quotes' and policyname = 'm15_quotes_read') then
    create policy m15_quotes_read on m15_quotes for select using (true);
  end if;
end $$;
