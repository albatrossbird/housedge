-- Give match_candidates room to finish.
--
-- 0007's RPC works and agrees with the JavaScript matcher — econ
-- returns the same single pair — but crypto and politics come back with
-- "canceling statement due to statement timeout" and fall back to the
-- slow path. Supabase caps statement_timeout for the API role at a few
-- seconds, which is right for ordinary reads and far too short for a
-- k-NN over 1,789 x 5,853 rows.
--
-- A function-scoped setting applies only while this function runs, so
-- the tight default still protects every other query. This does not
-- make the RPC slow — it stops a working query being killed halfway.
alter function match_candidates(text, int) set statement_timeout = '120s';

-- Confirm 0007's indexes exist. If this returns no rows the HNSW build
-- did not happen, and the timeouts are a missing index rather than a
-- short deadline — a different fix.
select indexname from pg_indexes
where tablename = 'markets' and indexname like 'markets_vec_%';
