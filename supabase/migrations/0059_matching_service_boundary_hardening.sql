-- Reciprocal matching v1: remove obsolete service paths and bind snapshot
-- resource limits to the immutable configuration selected by each run.

alter function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  set schema halal_mode_private;
alter function halal_mode_private.matching_candidate_snapshot_prepare_service(uuid, bigint)
  rename to matching_candidate_snapshot_prepare_unclamped;

revoke all on function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid, bigint)
  from public, anon, authenticated, service_role;

create or replace function public.matching_candidate_snapshot_prepare_service(
  p_run_id uuid,
  p_fail_limit bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_config_limit bigint;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching snapshot preparation requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_fail_limit is null or p_fail_limit < 1 then
    raise exception 'A run id and positive candidate fail limit are required'
      using errcode = '22023';
  end if;

  select (config.params ->> 'fail_edges_after_filter')::bigint
  into v_config_limit
  from halal_mode_private.matching_runs run
  join halal_mode_private.matching_config config
    on config.version = run.config_version
  where run.id = p_run_id;

  if v_config_limit is null or v_config_limit < 1 then
    raise exception 'The matching run has no valid configured candidate ceiling'
      using errcode = '22023';
  end if;

  return halal_mode_private.matching_candidate_snapshot_prepare_unclamped(
    p_run_id,
    least(p_fail_limit, v_config_limit)
  );
end;
$$;

revoke all on function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  to service_role;

-- These service functions predate immutable run snapshots. Leaving EXECUTE on
-- them would let a caller read candidates/signals that are not bound to a run
-- or create a run without its canonical cycle context.
revoke execute on function public.matching_run_start(text, integer, bigint, text)
  from service_role;
revoke execute on function public.matching_candidate_edges_service(uuid, uuid, integer)
  from service_role;
revoke execute on function public.matching_member_signals_service()
  from service_role;

comment on function public.matching_candidate_snapshot_prepare_service(uuid, bigint) is
  'Service-only snapshot preparation. The requested fail limit is capped by the immutable run configuration before candidate materialization.';
