-- 0035: movers — the home page's "moves" and "most traded" lists, across
-- Kalshi, Polymarket US and polymarket.com.
--
-- Written every 15 minutes by scripts/movers.mjs on the box, with the
-- service-role key, and read by /api/movers. Each run replaces a venue's
-- rows only when that venue's read completed, so the table is always one
-- recent snapshot per venue.
--
-- movers is PUBLIC DATA (prices and volumes the venues publish), so anon
-- may SELECT it. Nobody but the service role may write it: the default
-- grants are revoked and only SELECT is given back (see 0028 for why the
-- grant matters as much as the policy).
--
-- mover_snapshots and mover_history are our own readings of Polymarket
-- US, because that venue publishes no price from a day ago and only an
-- all-time volume: an hourly map of every tracked book's price (for
-- moves), and per-book all-time volume readings (for money traded). Both
-- service-role only: RLS on, no policies, grants revoked.
--
-- Idempotent: safe to run twice.

create table if not exists public.movers (
  venue       text not null check (venue in ('kalshi', 'polymarket_us', 'polymarket')),
  market_id   text not null,
  list        text not null check (list in ('moves', 'traded')),
  event_id    text,
  title       text not null,
  outcome     text,
  category    text not null,
  price       real,
  prev        real,                    -- about a day ago; null when unknown
  volume_usd  bigint,                  -- about a day; contracts x price on Kalshi and .us
  closes_at   timestamptz,
  url         text,
  also        jsonb not null default '[]'::jsonb,   -- the same claim on the other venues
  updated_at  timestamptz not null default now(),
  primary key (venue, market_id, list)
);

create index if not exists movers_list_idx on public.movers (list, category);

alter table public.movers enable row level security;
revoke all on public.movers from anon, authenticated;
grant select on public.movers to anon, authenticated;
drop policy if exists movers_read on public.movers;
create policy movers_read on public.movers for select to anon, authenticated using (true);

create table if not exists public.mover_history (
  venue       text not null,
  market_id   text not null,
  hist        jsonb not null default '[]'::jsonb,   -- [[unix seconds, price, shares traded], ...]
  updated_at  timestamptz not null default now(),
  primary key (venue, market_id)
);

create index if not exists mover_history_updated_idx on public.mover_history (updated_at);

alter table public.mover_history enable row level security;
revoke all on public.mover_history from anon, authenticated;

create table if not exists public.mover_snapshots (
  venue   text not null,
  at      timestamptz not null,
  prices  jsonb not null,                           -- { market id: price }
  primary key (venue, at)
);

alter table public.mover_snapshots enable row level security;
revoke all on public.mover_snapshots from anon, authenticated;
