-- Why does a 500-row page take 2-3 seconds when the index exists?
--
-- Both markets_category_keyset and markets_category_lookup are
-- confirmed present, so the index is NOT the missing piece — it was
-- there for the run that timed out. Three theories have now been wrong
-- (OFFSET paging, no index, migration did not apply), so this file
-- MEASURES rather than proposes.
--
-- The instrumented run said this, and it is the shape to explain:
--
--   page 0:  500 rows in 2.7s
--   page 1:  500 rows in 2.7s
--   page 4:  FAILED after 4.9s at size=500
--   page 5:  250 rows in 2.1s     <- half the rows, barely faster
--   page 12: 250 rows in 2.4s
--   page 14: FAILED after 4.7s at size=250
--   ...125 failed, and 62 failed after 3.2s
--
-- Pages cost 2-3s whatever their size, against a timeout that bites
-- somewhere around 3-5s. Everything sits just under the line and the
-- slow ones tip over.
--
-- STEP 5 OF 0019 WOULD HAVE MISLED US. It selected
-- `id, title, platform, sport_tag` while the matcher selects
-- `embedding_v` as well — a 4KB vector per row, TOASTed, so 500 rows is
-- ~2MB and ~500 extra out-of-line reads. Omitting it EXPLAINs a query
-- nobody runs, and it would have come back fast and read as an
-- all-clear. Query D below is that mistake, kept as the control.

-- ── A: what is the timeout we are actually hitting? ──────────────
show statement_timeout;

-- ── B: how big is the read? ──────────────────────────────────────
select platform, count(*) as rows
from markets
where sport_tag = 'politics' and embedding_v is not null
group by platform
order by platform;

-- ── C: THE REAL QUERY, vector included ───────────────────────────
-- This is what scripts/match-category.mjs issues, page 1. Read
-- `Buffers` and look for a large `read`/`hit` count against TOAST: if
-- the plan is an Index Scan and the time is still seconds, the cost is
-- fetching vectors, not finding rows — and no index can fix that.
explain (analyze, buffers, verbose)
select id, title, platform, sport_tag, embedding_v
from markets
where sport_tag = 'politics'
  and platform = 'kalshi'
  and embedding_v is not null
order by id
limit 500;

-- ── D: CONTROL — the same query WITHOUT the vector ───────────────
-- The difference between C and D is the whole answer. If D is
-- milliseconds and C is seconds, the index is doing its job and the
-- payload is the problem. If both are slow, the scan is.
explain (analyze, buffers)
select id, title, platform, sport_tag
from markets
where sport_tag = 'politics'
  and platform = 'kalshi'
  and embedding_v is not null
order by id
limit 500;
