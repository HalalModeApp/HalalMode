-- A runaway query must kill itself, not the API.
--
-- The single-shot finalizer did not merely fail slowly. Ten of its calls ended
-- up running at once, each holding one of the API's connections, and between
-- them they took the entire pool. PostgREST could no longer run even its own
-- schema-cache query, so it answered 503 to everything. The database was
-- healthy throughout; every client request failed anyway.
--
-- That is the real cost of an unbounded statement. One slow call is an
-- inconvenience. Ten of them is an outage, and it arrives without warning
-- because nothing in between looks like a problem.
--
-- Two things here. Kill what is still holding the pool, and give the
-- finalizers a ceiling so no future call can hold a connection indefinitely,
-- whatever goes wrong inside it. Batching already keeps each unit of work far
-- below this; the timeout is what makes that a guarantee rather than an
-- expectation.

do $$
declare
  v_killed integer := 0;
  v_pid integer;
begin
  for v_pid in
    select pid from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and state = 'active'
      and query ilike '%matching_shadow_finalize_service%'
      and now() - xact_start > interval '30 seconds'
  loop
    perform pg_terminate_backend(v_pid);
    v_killed := v_killed + 1;
  end loop;
  raise notice 'released % wedged finalizer sessions', v_killed;
end;
$$;

-- Generous enough that no legitimate batch comes close, short enough that a
-- stuck one frees its connection long before the pool notices.
alter function public.matching_shadow_open_service(uuid, integer) set statement_timeout = '30s';
alter function public.matching_shadow_batch_service(uuid, jsonb) set statement_timeout = '60s';
alter function public.matching_shadow_close_service(uuid, jsonb, bigint, jsonb) set statement_timeout = '30s';
alter function public.matching_shadow_finalize_service(uuid, jsonb, jsonb, bigint, jsonb) set statement_timeout = '60s';
alter function public.matching_live_finalize_service(uuid, jsonb, jsonb, jsonb, timestamptz, jsonb, bigint, jsonb) set statement_timeout = '60s';

-- The probes that produced the measurements are no longer needed, and each one
-- is another way to start a long query by hand.
drop function if exists public.time_shadow_finalize_service(uuid, jsonb);
drop function if exists public.time_validation_service(uuid, jsonb, integer);
drop function if exists public.time_finalize_hash_service(jsonb, integer);
