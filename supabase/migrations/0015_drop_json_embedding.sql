-- Drop markets.embedding, the JSON copy of what embedding_v already holds.
--
-- 266MB of an 800MB database, storing the same numbers twice: pgvector
-- keeps 1024 float4s in ~4KB, while the JSON text of the same array
-- compressed to ~7KB. Migration 0007 added the vector column WITHOUT
-- removing the original, which is why the database grew when it was
-- supposed to shrink.
--
-- SAFE TO RUN NOW, because nothing reads the column any more:
--
--   lib/matcher.js             -> embedding_v   (the live matching path)
--   scripts/match-category.mjs -> embedding_v   (what Actions runs)
--   pages/api/embed.js         -> embedding_v   (all five selects)
--
-- and embed.js no longer writes it either.
--
-- That cutover was verified against production rather than argued:
-- matchonly dry runs were captured before and after on identical inputs
-- (crypto 461 Kalshi x 7,521 Polymarket, 6,762 embedded, threshold 0.88).
-- econ came back byte-identical at 34 pairs. crypto went 29 -> 30, losing
-- nothing and gaining one correct pair that float4's different rounding
-- moved into acceptance:
--
--   Kalshi  Bitcoin above $109,999.99 by Dec 31, 2026 11:59 PM ET
--   Poly    Bitcoin reach $110,000 by December 31, 2026
--
-- read by hand against the cent-below strike convention, the deadline
-- rule and the touch-vs-terminal verb rule before being accepted.
--
-- The lesson to keep: float4 carries less precision than the float64
-- JSON did, so borderline candidates CAN move. One moved in, none moved
-- out. A future run could move one the other way, and the gates rather
-- than the score are what should be catching those.

-- Refuse rather than lose data. If any row still carries JSON without a
-- vector, the cutover missed it and dropping the column would destroy
-- the only copy.
do $$
declare
  orphaned bigint;
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'markets' and column_name = 'embedding') then
    raise notice 'markets.embedding already dropped; nothing to do';
    return;
  end if;

  select count(*) into orphaned
  from markets
  where embedding is not null and embedding_v is null;

  if orphaned > 0 then
    raise exception
      'refusing to drop: % rows have embedding but no embedding_v. Re-run /api/embed to backfill the vector first.',
      orphaned;
  end if;

  raise notice 'dropping markets.embedding';
  execute 'alter table markets drop column embedding';
end $$;

-- RECLAIMING THE SPACE IS A SEPARATE STEP, AND NOT AUTOMATIC.
--
-- `drop column` marks the attribute dropped; it does not rewrite the
-- table, so the TOAST entries stay on disk and the reported database
-- size will NOT fall on its own. Space is returned by a rewrite:
--
--   vacuum (full, analyze) markets;
--
-- That takes an ACCESS EXCLUSIVE lock for its duration — reads and
-- writes to `markets` block, so the site serves errors while it runs —
-- and needs free disk roughly equal to the table. On the free tier that
-- was not safely possible at 776MB; on Pro it is. Run it deliberately,
-- not as part of this migration.
