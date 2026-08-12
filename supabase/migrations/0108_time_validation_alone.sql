-- Time validation alone, on a slice of the edges.
--
-- Timing both halves together loses to the gateway's own 125-second limit: the
-- call is killed before it can answer, so the measurement dies with it. This
-- validates a given number of edges and writes nothing, so it can be run
-- repeatedly on a slice small enough to return — and the shape of the curve
-- across slice sizes says whether the cost is per edge or per edge squared.

create or replace function public.time_validation_service(p_run_id uuid, p_edges jsonb, p_take integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set lock_timeout = '15s'
as $$
declare
  v_slice jsonb;
  v_started timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing validation requires service role' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_slice
  from (select e from jsonb_array_elements(p_edges) e limit greatest(1, p_take)) sliced;

  v_started := clock_timestamp();
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, v_slice, now());
  return jsonb_build_object(
    'edges', jsonb_array_length(v_slice),
    'validate_ms', round(extract(epoch from (clock_timestamp() - v_started)) * 1000)
  );
end;
$$;

revoke all on function public.time_validation_service(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.time_validation_service(uuid, jsonb, integer) to service_role;
