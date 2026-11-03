-- 0033: accounts — profiles (plan, referral) and affiliates.
--
-- Users themselves live in Supabase Auth (auth.users). A profile is the
-- MarketSlap side of a user: which plan they hold, until when, and which
-- affiliate code brought them. It is created by the server the first time a
-- user finishes signing in (lib/auth/profiles.js), never by the browser.
--
-- PRIVATE BY CONSTRUCTION. RLS is on with NO policies, and SELECT/INSERT/
-- UPDATE/DELETE are revoked from anon and authenticated, so only the
-- service-role key (server-side API routes) can read or write either table.
-- A user's plan must never be writable by the user, and a table in public
-- is granted to anon by default — see CLAUDE.md "The recorded archives are
-- private (migration 0028)": revoking the grant matters as much as the
-- policy, because RLS with no policy answers an empty 200 where a revoked
-- grant answers 42501.
--
-- Idempotent: safe to run twice.

create table if not exists public.affiliates (
  code               text primary key check (code ~ '^[A-Z0-9_-]{3,32}$'),
  name               text not null,
  email              text,
  profile_id         uuid,                          -- the affiliate's own account, if any (blocks self-referral)
  commission_pct     numeric not null default 30 check (commission_pct >= 0 and commission_pct <= 100),
  commission_months  integer default 12 check (commission_months is null or commission_months > 0),  -- null = lifetime
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text not null,
  plan                text not null default 'free' check (plan in ('free', 'ev', 'arb', 'pro')),
  plan_until          timestamptz,                  -- null = no end (a comp account); Stripe will set the period end
  pass_until          timestamptz,                  -- a day pass: everything until then, beside whatever plan is held
  referred_by         text references public.affiliates (code) on update cascade on delete set null,
  agreed_18_at        timestamptz,                  -- when they confirmed they are 18 or older
  stripe_customer_id  text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists profiles_referred_by_idx on public.profiles (referred_by) where referred_by is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'affiliates_profile_id_fkey') then
    alter table public.affiliates
      add constraint affiliates_profile_id_fkey foreign key (profile_id) references public.profiles (id) on delete set null;
  end if;
end $$;

alter table public.profiles   enable row level security;
alter table public.affiliates enable row level security;
revoke all on public.profiles   from anon, authenticated;
revoke all on public.affiliates from anon, authenticated;
