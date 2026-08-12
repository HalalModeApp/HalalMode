-- Time the real insert. It is the only thing left.
--
-- Building the identical 148 rows into an unconstrained temporary table takes
-- 2ms. Every check around it is single-digit milliseconds and the lock phase is
-- 2ms with all locks free. The batch that contains them takes 115 seconds.
--
-- Whatever the difference is, it is in writing those rows to
-- shadow_round_edges rather than in producing them. The table has no triggers
-- and no extra indexes, so what remains is its constraints: a primary key and
-- three foreign keys, one of which points every single row at the same
-- matching_runs row.

create or replace function public.time_real_insert_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_t timestamptz;
  v_insert numeric;
  v_count integer;
  v_count_ms numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  v_t := clock_timestamp();
  insert into halal_mode_private.shadow_round_edges (
    run_id, viewer_id, subject_id, reciprocal_score, adjusted_utility
  )
  select p_run_id, (e ->> 'a')::uuid, (e ->> 'b')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  union all
  select p_run_id, (e ->> 'b')::uuid, (e ->> 'a')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  on conflict (run_id, viewer_id, subject_id) do nothing;
  v_insert := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select count(*)::integer into v_count
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  v_count_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object(
    'insert_ms', v_insert,
    'count_ms', v_count_ms,
    'rows_now', v_count
  );
end;
$$;

revoke all on function public.time_real_insert_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_real_insert_service(uuid, jsonb) to service_role;
