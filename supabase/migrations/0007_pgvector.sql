-- pgvector: store embeddings as vectors, and match them in the database.
--
-- WHY THIS IS THE CEILING PROBLEM.
--
-- `markets.embedding` holds a JSON-encoded float array — roughly 20KB a
-- row. About 11,300 rows carry one (politics ~7,400, crypto ~3,900), so
-- embeddings alone are ~225MB of a 500MB free tier, and only 62 of those
-- rows are in a pair. They cannot simply be deleted: the unpaired ones
-- ARE the candidate pool, and dropping them means paying Voyage to
-- recompute them on the next run.
--
-- A `vector(n)` stores the same numbers as float4: ~4KB against ~20KB,
-- a 5x reduction with no loss of precision that matters here.
--
-- It also fixes a second problem. Matching currently reads every
-- embedding out of Postgres and computes cosine similarity in
-- JavaScript, which is what made a 1000-row page ~20MB and started
-- failing outright once crypto and politics grew. match_candidates()
-- below does the comparison in the database and returns only the
-- (kalshi_id, polymarket_id, score) triples, so no embedding crosses
-- the wire at all.
--
-- Idempotent, and non-destructive: the original `embedding` column is
-- left in place. Dropping it is a separate decision, taken once the
-- vector path has been verified against real matches.

create extension if not exists vector;

-- ── Column ─────────────────────────────────────────────────────
-- The dimension comes from the data rather than from a constant, so
-- this does not have to be edited when the embedding model changes —
-- and cannot silently disagree with what is stored. voyage-4-large is
-- the current model; its output width is whatever these rows have.
do $$
declare
  dim int;
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'markets' and column_name = 'embedding_v') then
    return;
  end if;

  select jsonb_array_length(embedding::jsonb) into dim
  from markets
  where embedding is not null
  limit 1;

  if dim is null then
    raise notice 'no embeddings stored; skipping embedding_v';
    return;
  end if;

  raise notice 'creating markets.embedding_v as vector(%)', dim;
  execute format('alter table markets add column embedding_v vector(%s)', dim);
end $$;

-- ── Backfill ───────────────────────────────────────────────────
-- In batches. A single UPDATE over ~11,300 rows each carrying 20KB of
-- JSON is one long transaction and a lot of WAL on a small instance;
-- this keeps each step short and is safe to re-run if it is
-- interrupted, because it only ever touches rows still lacking a vector.
do $$
declare
  moved int;
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'markets' and column_name = 'embedding_v') then
    return;
  end if;

  loop
    with batch as (
      select id from markets
      where embedding is not null and embedding_v is null
      limit 500
    )
    update markets m
       set embedding_v = m.embedding::text::vector
      from batch b
     where m.id = b.id;

    get diagnostics moved = row_count;
    exit when moved = 0;
    raise notice 'backfilled % rows', moved;
  end loop;
end $$;

-- ── Index ──────────────────────────────────────────────────────
-- Partial, one per matched category, because that is how the matcher
-- queries: never across all markets, always within one sport_tag on one
-- platform. A single index over everything would be larger and would
-- force a filter step that HNSW handles poorly.
--
-- vector_cosine_ops to match the <=> operator used below. If the HNSW
-- build runs out of memory on a small instance, an ivfflat index is the
-- cheaper substitute and the queries are unchanged.
do $$
declare
  cat text;
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'markets' and column_name = 'embedding_v') then
    return;
  end if;

  foreach cat in array array['econ', 'crypto', 'politics'] loop
    execute format(
      'create index if not exists markets_vec_poly_%s on markets using hnsw (embedding_v vector_cosine_ops) where platform = ''polymarket'' and sport_tag = %L and embedding_v is not null',
      cat, cat);
  end loop;
end $$;

-- ── Matching in the database ───────────────────────────────────
-- For each Kalshi row in a category, the p_top_k nearest Polymarket
-- rows. Not a cross join: politics alone is 1,789 x 5,654 = 10M pairs,
-- and all but a handful of each row's neighbours are irrelevant. The
-- lateral gives the index a per-row k-NN query, which is what HNSW is
-- for.
--
-- Returns scores for every candidate regardless of threshold. The
-- caller still applies the scalar-signature gate and the score floor —
-- this replaces the O(n*m) JavaScript loop and the 20MB of embeddings
-- it needed, not the matching policy.
--
-- <=> is cosine DISTANCE, so similarity is 1 - distance.
drop function if exists match_candidates(text, int);

create function match_candidates(p_sport_tag text, p_top_k int default 10)
returns table (kalshi_id text, polymarket_id text, score double precision)
language sql stable
as $$
  select k.id, p.id, (1 - (k.embedding_v <=> p.embedding_v))::double precision
  from markets k
  cross join lateral (
    select pm.id, pm.embedding_v
    from markets pm
    where pm.platform = 'polymarket'
      and pm.sport_tag = p_sport_tag
      and pm.embedding_v is not null
    order by pm.embedding_v <=> k.embedding_v
    limit p_top_k
  ) p
  where k.platform = 'kalshi'
    and k.sport_tag = p_sport_tag
    and k.embedding_v is not null
$$;
