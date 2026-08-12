-- One stuck transaction must not stop matching forever.
--
-- Finalization takes a global advisory lock — 'matching-legal-consent-epoch' —
-- before it validates edges. Taking it is right: it is what stops a block, a
-- withdrawn consent, or a pass slipping in between validating a round and
-- writing it. Waiting for it forever is not.
--
-- What that cost today: a shadow run stopped after its candidate snapshot,
-- twice, with no error recorded. The planner was innocent — replayed on the
-- same 53 members and 431 edges it finishes in 14ms — and both database reads
-- answer in about a second. Calling the finalizer directly hung for 126
-- seconds and returned a gateway timeout. Every run after the first was
-- queueing behind a lock nobody was going to release, and because the process
-- was killed while waiting rather than failing, it never got to write down why.
--
-- A lock wait is now bounded. Blocked finalization fails quickly and loudly
-- with a real error in the run row, which is recoverable and legible, instead
-- of hanging until the platform kills it, which is neither.

alter function public.matching_shadow_finalize_service(uuid, jsonb, jsonb, bigint, jsonb)
  set lock_timeout = '15s';
alter function public.matching_live_finalize_service(uuid, jsonb, jsonb, jsonb, timestamptz, jsonb, bigint, jsonb)
  set lock_timeout = '15s';
alter function halal_mode_private.validate_frozen_matching_edges(uuid, jsonb, timestamptz)
  set lock_timeout = '15s';

-- Seeing who is holding things up, and cutting a wedged session loose.
--
-- There was no way to ask the database what it was waiting for, which is why
-- this took a direct call to the finalizer to find. Counts and states only —
-- no query text, since that can carry member data.
create or replace function public.stuck_sessions_service(p_minimum_seconds integer default 30)
returns table (
  pid integer,
  state text,
  waiting_on text,
  seconds_running numeric,
  seconds_idle_in_transaction numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public as $$
  select
    a.pid,
    a.state,
    a.wait_event_type || ':' || coalesce(a.wait_event, 'none'),
    round(extract(epoch from (now() - a.query_start))::numeric, 1),
    round(extract(epoch from (now() - a.xact_start))::numeric, 1)
  from pg_stat_activity a
  where a.datname = current_database()
    and a.pid <> pg_backend_pid()
    and a.state is distinct from 'idle'
    and a.xact_start is not null
    and now() - a.xact_start > make_interval(secs => greatest(1, p_minimum_seconds))
  order by a.xact_start;
$$;

revoke all on function public.stuck_sessions_service(integer) from public, anon, authenticated;
grant execute on function public.stuck_sessions_service(integer) to service_role;

create or replace function public.release_stuck_session_service(p_pid integer)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public as $$
declare
  v_idle_seconds numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Releasing a session requires service role' using errcode = '42501';
  end if;

  -- Only a session that has genuinely been sitting in a transaction. This is
  -- not a general "kill any query" tool, and should not become one.
  select extract(epoch from (now() - xact_start)) into v_idle_seconds
  from pg_stat_activity
  where pid = p_pid and datname = current_database() and xact_start is not null;

  if v_idle_seconds is null or v_idle_seconds < 60 then
    raise exception 'Session % is not a long-running transaction', p_pid using errcode = '22023';
  end if;

  return pg_terminate_backend(p_pid);
end;
$$;

revoke all on function public.release_stuck_session_service(integer) from public, anon, authenticated;
grant execute on function public.release_stuck_session_service(integer) to service_role;
