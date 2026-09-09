-- Kalshi's daily temperature markets, and the forecast they will be
-- judged against.
--
-- WHY THIS EXISTS SEPARATELY FROM m15. A 15-minute crypto market and a
-- daily temperature market look alike (a ladder of price buckets that
-- settles against a number) and are not: the temperature one has a
-- PUBLIC FORECAST available a day ahead, which is the whole reason it
-- might be mispriced. So the forecast is recorded alongside the book,
-- not left to be reconstructed later.
--
-- THE FACT THAT DECIDES THE MODEL, and the reason this is worth
-- recording rather than assuming. Measured 2026-09-09, every daily
-- temperature series resolves "according to THE WEATHER COMPANY":
--
--   Miami CLIMIA, Minneapolis CLIMSP, Dallas CLIDFW, Denver CLIDEN,
--   Atlanta CLIATL, DC CLIDCA, NYC CLINYC, Seattle CLISEA
--
-- The stations are NWS climate sites, but the settling VALUE comes via
-- The Weather Company (IBM), while every competing tool advertises
-- NOAA/NWS/GFS. Modelling one source and settling on another is basis
-- risk, and on a 2-degree bucket a half-degree disagreement flips the
-- contract. wx_forecasts records what NWS said so that basis can be
-- MEASURED against what Kalshi actually settled, rather than assumed
-- to be zero.

create table if not exists wx_markets (
  ticker        text primary key,
  series        text not null,
  event_ticker  text,
  station       text,              -- ICAO, e.g. KMIA
  cli           text,              -- Kalshi's climate product, e.g. CLIMIA
  title         text,
  -- The bucket, from Kalshi's own fields rather than parsed out of
  -- "94° or above". `strike_type` is 'greater' / 'less' / 'between',
  -- and a null cap on a 'greater' market is the open-ended top rung.
  strike_type   text,
  floor_strike  double precision,
  cap_strike    double precision,
  -- The DAY being forecast, which is not close_time: a market for
  -- Sep 10 closes at 05:00Z on Sep 11.
  target_date   date,
  close_time    timestamptz,
  result        text,              -- null until Kalshi settles
  last_price    double precision,
  volume        double precision,
  open_interest double precision,
  updated_at    timestamptz not null default now()
);
create index if not exists wx_markets_series_date_idx on wx_markets (series, target_date desc);
create index if not exists wx_markets_settled_idx on wx_markets (target_date desc) where result is not null;

-- Append-only ladder snapshots, write-on-change like m15_quotes.
create table if not exists wx_quotes (
  id            bigserial primary key,
  ticker        text not null,
  observed_at   timestamptz not null default now(),
  -- Hours until the market closes. Stored rather than derived because
  -- every question here is "how far ahead was this quoted".
  hours_to_close double precision,
  yes_bid       double precision,
  yes_ask       double precision,
  bid_size      double precision,
  ask_size      double precision,
  volume        double precision
);
create index if not exists wx_quotes_ticker_idx on wx_quotes (ticker, observed_at);
create index if not exists wx_quotes_observed_idx on wx_quotes (observed_at desc);

-- What the forecast said, and WHEN it said it. A forecast is only
-- interesting relative to how far ahead it was made, so (station,
-- target_date, observed_at) is the grain — not one row per day.
create table if not exists wx_forecasts (
  id           bigserial primary key,
  station      text not null,
  target_date  date not null,
  observed_at  timestamptz not null default now(),
  source       text not null,      -- 'nws' today; room for others
  high_f       double precision,
  low_f        double precision,
  -- Free-text conditions, kept because precipitation markets will want
  -- it and it costs nothing to store now.
  short_forecast text
);
create index if not exists wx_forecasts_lookup_idx on wx_forecasts (station, target_date, observed_at desc);

alter table wx_markets   enable row level security;
alter table wx_quotes    enable row level security;
alter table wx_forecasts enable row level security;

-- Anon reads, service-role writes — the same posture as m15 (0016).
do $$
begin
  if not exists (select 1 from pg_policies where tablename='wx_markets' and policyname='wx_markets_read') then
    create policy wx_markets_read on wx_markets for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='wx_quotes' and policyname='wx_quotes_read') then
    create policy wx_quotes_read on wx_quotes for select using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='wx_forecasts' and policyname='wx_forecasts_read') then
    create policy wx_forecasts_read on wx_forecasts for select using (true);
  end if;
end $$;
