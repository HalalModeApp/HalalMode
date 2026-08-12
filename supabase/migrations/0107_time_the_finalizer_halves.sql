-- Which half of finalization is eating the minutes.
--
-- Finalization is two steps behind one call: validate the planned edges against
-- current safety state, then write them. From outside, both are just "the
-- finalizer took 126 seconds". This times them separately so the fix lands on
-- the right one instead of the likely-looking one.
--
-- Shadow runs only. It writes what the shadow finalizer writes, to a table
-- nothing reads, so it is safe to run against the live project.

create or replace function public.time_shadow_finalize_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set lock_timeout = '15s'
as $$
declare
  v_mode text;
  v_started timestamptz;
  v_validated timestamptz;
  v_persisted timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing finalization requires service role' using errcode = '42501';
  end if;

  select mode into v_mode from halal_mode_private.matching_runs where id = p_run_id;
  if v_mode is distinct from 'shadow' then
    raise exception 'Only a shadow run may be timed' using errcode = '22023';
  end if;

  v_started := clock_timestamp();
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());
  v_validated := clock_timestamp();
  perform halal_mode_private.persist_validated_shadow_edges(p_run_id, p_edges);
  v_persisted := clock_timestamp();

  return jsonb_build_object(
    'validate_ms', round(extract(epoch from (v_validated - v_started)) * 1000),
    'persist_ms', round(extract(epoch from (v_persisted - v_validated)) * 1000),
    'edges', jsonb_array_length(p_edges)
  );
end;
$$;

revoke all on function public.time_shadow_finalize_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_shadow_finalize_service(uuid, jsonb) to service_role;
