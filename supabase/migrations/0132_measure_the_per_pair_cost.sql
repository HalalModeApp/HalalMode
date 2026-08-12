-- How many pairs survive the pre-filter, and what each check costs per pair.
--
-- The claim is that the remaining cost is `matching_pair_is_eligible` and two
-- `compatibility` calls, each re-reading the same rows. That is a theory, and
-- two theories about this have already been wrong today, so it gets measured
-- before anything is built on it.
--
-- Bounded by a sample size so it cannot itself become a query that will not
-- finish. Per-pair cost times surviving pairs gives the real total, and the
-- surviving count says how aggressive a shortlist would need to be.

create or replace function public.measure_pair_cost_service(p_sample integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_t timestamptz;
  v_surviving bigint;
  v_pool integer;
  v_cheap_ms numeric;
  v_eligible_ms numeric;
  v_compat_ms numeric;
  v_sample integer := greatest(1, least(p_sample, 2000));
  v_hits integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Measuring requires service role' using errcode = '42501';
  end if;

  select count(*) into v_pool from halal_mode_private.matching_pool;

  -- The pre-filter alone: column comparisons, no functions.
  v_t := clock_timestamp();
  select count(*) into v_surviving
  from halal_mode_private.matching_pool m
  join halal_mode_private.matching_pool f on f.gender = 'female'
  where m.gender = 'male'
    and (
      lower(btrim(m.country)) = lower(btrim(f.country))
      or (m.relocation in ('open', 'willing_abroad')
        and (coalesce(array_length(m.preferred_countries, 1), 0) = 0
          or exists (select 1 from unnest(m.preferred_countries) a(c)
                     where lower(btrim(a.c)) = lower(btrim(f.country)))))
    )
    and (
      lower(btrim(f.country)) = lower(btrim(m.country))
      or (f.relocation in ('open', 'willing_abroad')
        and (coalesce(array_length(f.preferred_countries, 1), 0) = 0
          or exists (select 1 from unnest(f.preferred_countries) a(c)
                     where lower(btrim(a.c)) = lower(btrim(m.country)))))
    );
  v_cheap_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  -- The eligibility authority, on a sample.
  v_t := clock_timestamp();
  select count(*) into v_hits from (
    select m.id as a, f.id as b
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    where m.gender = 'male'
    limit v_sample
  ) s
  where halal_mode_private.matching_pair_is_eligible(
    least(s.a, s.b), greatest(s.a, s.b), now(),
    halal_mode_private.active_matching_config_version()
  );
  v_eligible_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  -- Both compatibility calls, on the same sample size.
  v_t := clock_timestamp();
  perform halal_mode_private.compatibility(least(s.a, s.b), greatest(s.a, s.b))
        + halal_mode_private.compatibility(greatest(s.a, s.b), least(s.a, s.b))
  from (
    select m.id as a, f.id as b
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    where m.gender = 'male'
    limit v_sample
  ) s;
  v_compat_ms := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object(
    'pool_members', v_pool,
    'pairs_after_prefilter', v_surviving,
    'prefilter_ms', v_cheap_ms,
    'sample', v_sample,
    'eligible_ms_for_sample', v_eligible_ms,
    'compatibility_ms_for_sample', v_compat_ms,
    'projected_total_seconds',
      round(((v_eligible_ms + v_compat_ms) / v_sample::numeric * v_surviving) / 1000.0, 1)
  );
end;
$$;

revoke all on function public.measure_pair_cost_service(integer) from public, anon, authenticated;
grant execute on function public.measure_pair_cost_service(integer) to service_role;
