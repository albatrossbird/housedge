-- 0034: payments — one row per payment Stripe took, for commissions and
-- the books.
--
-- Written only by the Stripe webhook (lib/billing/sync.js) with the
-- service-role key. A subscription payment is keyed on its invoice id
-- (in_...), a day pass on its Checkout Session id (cs_...), so a webhook
-- delivered twice writes the same row twice and nothing more.
--
-- referred_by is COPIED from the profile when the payment is recorded, so a
-- commission report reads one table and a later change to the profile
-- cannot move money already earned. Commission terms stay on affiliates.
--
-- The day pass is also derived from here: pass_until is the chain of every
-- pass row, each starting when the one before it ends, so two passes bought
-- on one day stack to 48 hours however often either event is redelivered.
--
-- PRIVATE BY CONSTRUCTION, like 0033: RLS on with no policies, and the
-- default grants revoked from anon and authenticated.
--
-- Idempotent: safe to run twice.

create table if not exists public.payments (
  id              text primary key,                -- in_... (subscription) or cs_... (day pass)
  profile_id      uuid references public.profiles (id) on delete set null,
  customer_id     text,                            -- Stripe cus_...
  kind            text not null check (kind in ('subscription', 'pass')),
  plan            text,                            -- ev | arb | pro for a subscription
  amount_cents    integer not null check (amount_cents >= 0),
  currency        text not null default 'usd',
  refunded_cents  integer not null default 0 check (refunded_cents >= 0),
  payment_intent  text,                            -- pi_..., how a refund finds its payment
  referred_by     text,                            -- the affiliate code at the time of payment
  livemode        boolean not null default false,  -- test-mode payments are kept apart from real ones
  paid_at         timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists payments_profile_idx  on public.payments (profile_id, kind, paid_at);
create index if not exists payments_referred_idx on public.payments (referred_by, paid_at) where referred_by is not null;
create index if not exists payments_intent_idx   on public.payments (payment_intent) where payment_intent is not null;

alter table public.payments enable row level security;
revoke all on public.payments from anon, authenticated;
