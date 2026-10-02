-- Paper trades: what scripts/paper-m15.mjs WOULD have done on Kalshi's
-- 15-minute markets, decided live against the real order book, with no
-- order ever sent. One row per (market, rule): the decision, the
-- simulated fill against a second read of the book, and the settlement.
--
-- WHY A TABLE. The daily report reads it beside the backtest, so the
-- question "does the live rule do what the backtest says" has an answer
-- per day. It is small: at most one row per window per rule.
--
-- PRIVATE, like every recorded table here (migration 0028): RLS on, no
-- policies, and SELECT revoked from anon and authenticated. A new table
-- in public is anon-granted by default, so the revoke is in the same
-- migration that creates it. Writes and reads use the service-role key.
--
-- Idempotent.

create table if not exists paper_trades (
  id              text primary key,          -- '<ticker>|<rule>'
  rule            text not null,
  series          text not null,
  ticker          text not null,
  close_time      timestamptz not null,
  side            text not null,             -- 'yes' | 'no'
  decided_at      timestamptz not null,      -- the book read the rule fired on
  decided_secs    real not null,             -- seconds to close at that read
  decided_price   real not null,             -- the ask on that read (the limit)
  qty_wanted      integer not null,
  qty_filled      integer not null,          -- 0 = the book had moved past the limit
  fill_price      real,                      -- the limit; null when nothing filled
  fill_latency_ms integer,                   -- decision read to second read
  fee             real,                      -- Kalshi taker fee on the filled qty
  result          text,                      -- 'yes' | 'no' once settled
  pnl             real,                      -- dollars, after fee, once settled
  source          text,                      -- 'box', 'actions', 'unlabelled'
  settled_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists paper_trades_unsettled on paper_trades (close_time) where result is null;
create index if not exists paper_trades_close on paper_trades (close_time);

alter table paper_trades enable row level security;
revoke all on paper_trades from anon, authenticated;

-- Verify (expect rls on, and no grants to anon/authenticated):
--   select relrowsecurity from pg_class where relname = 'paper_trades';
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'paper_trades' and grantee in ('anon','authenticated');
