-- Time the inside of a finalization batch, on a run with a large snapshot.
--
-- A batch of 25 pairs times out, so the cost is fixed rather than per-edge, and
-- the only thing that changed is the candidate snapshot holding 11,043 rows
-- instead of 431. Statement by statement, with the ceiling lifted so it can
-- report a number instead of dying.

create or replace function public.time_batch_parts_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set statement_timeout = '110s'
as $$
declare
  v_t timestamptz;
  v_out jsonb := '{}'::jsonb;
  v_run halal_mode_private.matching_runs%rowtype;
  v_dummy boolean;
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Requires service role' using errcode = '42501';
  end if;

  v_t := clock_timestamp();
  select * into v_run from halal_mode_private.matching_runs where id = p_run_id;
  v_out := v_out || jsonb_build_object('read_run_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  -- The frozen-candidate check against a snapshot that now has 11,043 rows.
  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    left join halal_mode_private.matching_run_candidate_snapshots c
      on c.run_id = p_run_id and c.user_low = least(e.a, e.b) and c.user_high = greatest(e.a, e.b)
    where c.run_id is null
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('frozen_check_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  -- Validation as a whole, which is checks plus the lock phase.
  v_t := clock_timestamp();
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());
  v_out := v_out || jsonb_build_object('validate_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select count(*)::integer into v_count
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  v_out := v_out || jsonb_build_object('count_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  return v_out || jsonb_build_object('edges', jsonb_array_length(p_edges));
end;
$$;

revoke all on function public.time_batch_parts_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_batch_parts_service(uuid, jsonb) to service_role;
