-- The two pieces still never timed on their own.
--
-- Six of the veto checks are single-digit milliseconds at 74 edges and the
-- lock phase is 2ms with every lock free. The batch containing them takes 115
-- seconds with nothing else running. Two things were skipped:
--
--   the check that every chosen edge is one of the frozen candidates
--   the insert itself, in the exact shape the batch function uses
--
-- Both are timed here, and the insert is timed twice — once into a temporary
-- table with no constraints, once as the real thing — because if the
-- difference between those two is the ninety seconds, the cost is foreign key
-- checking rather than the write.

create or replace function public.time_remaining_parts_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_t timestamptz;
  v_frozen numeric;
  v_plain numeric;
  v_dummy boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  -- Is every edge one of the frozen candidates for this run?
  v_t := clock_timestamp();
  select exists (
    with parsed as materialized (
      select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b
      from jsonb_array_elements(p_edges) e
    )
    select 1 from parsed p
    where not exists (
      select 1 from halal_mode_private.matching_run_candidate_snapshots c
      where c.run_id = p_run_id
        and c.user_low = least(p.a, p.b)
        and c.user_high = greatest(p.a, p.b)
    )
  ) into v_dummy;
  v_frozen := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  -- The same rows the insert would build, materialised but not written. This
  -- separates producing the rows from storing them.
  create temporary table if not exists hm_probe_rows (
    run_id uuid, viewer_id uuid, subject_id uuid, s numeric, u numeric
  ) on commit drop;

  v_t := clock_timestamp();
  insert into hm_probe_rows
  select p_run_id, (e ->> 'a')::uuid, (e ->> 'b')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  union all
  select p_run_id, (e ->> 'b')::uuid, (e ->> 'a')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e;
  v_plain := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object(
    'edges', jsonb_array_length(p_edges),
    'frozen_candidate_check_ms', v_frozen,
    'build_rows_no_constraints_ms', v_plain,
    'rows_built', (select count(*) from hm_probe_rows)
  );
end;
$$;

revoke all on function public.time_remaining_parts_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_remaining_parts_service(uuid, jsonb) to service_role;
