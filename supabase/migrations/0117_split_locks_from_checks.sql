-- Lock phase, or insert? Nothing else is left.
--
-- Every individual check inside validation is now measured at single-digit
-- milliseconds for all 74 edges, and the insert was about a second. The batch
-- containing them takes ninety. Two pieces have never been timed on their own:
-- acquiring the ~130 advisory locks, and the insert as it is actually written
-- in the batch function.
--
-- This times validation as a whole — which is the checks plus the lock phase,
-- and the checks are known to be ~10ms — so anything large here is the locks.

create or replace function public.time_lock_phase_service(p_run_id uuid, p_edges jsonb, p_take integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_slice jsonb;
  v_t timestamptz;
  v_validate numeric;
  v_taken integer := 0;
  v_missed integer := 0;
  v_user uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_slice
  from (select e from jsonb_array_elements(p_edges) e limit greatest(1, p_take)) s;

  -- Try each member lock once, without waiting. Whether they are free at all is
  -- the question; how long the real function then waits follows from it.
  v_t := clock_timestamp();
  for v_user in
    select distinct member_id
    from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    cross join lateral (values (e.a), (e.b)) member(member_id)
    order by member_id
  loop
    if pg_try_advisory_xact_lock(hashtextextended(v_user::text, 1919)) then
      v_taken := v_taken + 1;
    else
      v_missed := v_missed + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'edges', jsonb_array_length(v_slice),
    'member_locks_free', v_taken,
    'member_locks_held_by_others', v_missed,
    'lock_probe_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000)
  );
end;
$$;

revoke all on function public.time_lock_phase_service(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.time_lock_phase_service(uuid, jsonb, integer) to service_role;
