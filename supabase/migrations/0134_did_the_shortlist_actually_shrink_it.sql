-- How big is the shortlist, and how long does the real query take?
--
-- The shortlist is in and the run still times out, so either it did not shrink
-- the set as much as expected or the ceiling is lower than assumed. Both are
-- one measurement away, and guessing has been expensive today.

create or replace function public.measure_shortlist_service()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_t timestamptz;
  v_pairs bigint;
  v_shortlist_ms numeric;
  v_page_rows integer;
  v_page_ms numeric;
  v_timeout text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Measuring requires service role' using errcode = '42501';
  end if;

  v_timeout := current_setting('statement_timeout', true);

  -- How many survive the shortlist, without any per-pair function.
  v_t := clock_timestamp();
  select count(*) into v_pairs from (
    select 1
    from (
      select m.id mid, f.id fid,
             row_number() over (partition by m.id order by abs(m.age - f.age), f.id) hr,
             row_number() over (partition by f.id order by abs(m.age - f.age), m.id) hr2
      from halal_mode_private.matching_pool m
      join halal_mode_private.matching_pool f on f.gender = 'female'
      where m.gender = 'male'
    ) r
    where r.hr <= 40 or r.hr2 <= 40
  ) s;
  v_shortlist_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  -- One real page of the actual function, which is what the caller does.
  v_t := clock_timestamp();
  select count(*) into v_page_rows
  from halal_mode_private.matching_candidate_edges(null, null, 1000);
  v_page_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object(
    'statement_timeout', v_timeout,
    'shortlisted_pairs', v_pairs,
    'shortlist_ms', v_shortlist_ms,
    'first_page_rows', v_page_rows,
    'first_page_ms', v_page_ms
  );
end;
$$;

revoke all on function public.measure_shortlist_service() from public, anon, authenticated;
grant execute on function public.measure_shortlist_service() to service_role;
