-- The last unmeasured step.
--
-- Every other part of finalization has now been timed against the data that
-- killed it, and all of them are fast and flat:
--
--   planning            14ms   (replayed off-database)
--   candidate reads    ~2s
--   edge validation     16ms for 16 edges, flat
--   writing the edges  ~1s for 1 edge and ~1s for 8 — fixed cost, not per edge
--
-- Yet the whole call, with 74 edges, runs past two minutes. Only one step is
-- left unaccounted for: the hash taken over the edges before anything else
-- happens, which exists so a retry can prove it is the same calculation rather
-- than a different one. Nothing else in the path grows with edge count.
--
-- If the cost is there, it will show as a curve across these slice sizes.

create or replace function public.time_finalize_hash_service(p_edges jsonb, p_take integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_slice jsonb;
  v_started timestamptz;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing the finalization hash requires service role' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_slice
  from (select e from jsonb_array_elements(p_edges) e limit greatest(1, p_take)) sliced;

  v_started := clock_timestamp();
  v_hash := halal_mode_private.matching_finalize_hash(
    'shadow', v_slice, '[]'::jsonb, '[]'::jsonb, null, '{}'::jsonb, 0, '[]'::jsonb
  );
  return jsonb_build_object(
    'edges', jsonb_array_length(v_slice),
    'hash_ms', round(extract(epoch from (clock_timestamp() - v_started)) * 1000)
  );
end;
$$;

revoke all on function public.time_finalize_hash_service(jsonb, integer) from public, anon, authenticated;
grant execute on function public.time_finalize_hash_service(jsonb, integer) to service_role;
