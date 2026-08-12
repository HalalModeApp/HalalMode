-- Validation as one call, timed.
--
-- Its parts have all been measured: lock phase 2ms with every lock free, six
-- vetoes ~13ms, frozen-candidate check 3ms, and the real insert 19ms. Those add
-- up to well under a tenth of a second, and the function that performs exactly
-- them takes 115 seconds.
--
-- Either validation as a whole is slow in a way none of its parts are, or the
-- cost is not in validation at all. This is one number and it settles which.

create or replace function public.time_validate_whole_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_t timestamptz;
  v_ms numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  v_t := clock_timestamp();
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());
  v_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object('edges', jsonb_array_length(p_edges), 'validate_whole_ms', v_ms);
end;
$$;

revoke all on function public.time_validate_whole_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_validate_whole_service(uuid, jsonb) to service_role;
