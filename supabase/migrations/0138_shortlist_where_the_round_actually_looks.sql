-- Shortlist inside the snapshot, which is the path that actually runs.
--
-- The pre-filter and shortlist added earlier went into
-- `matching_candidate_edges`, and the round never calls it. Candidate
-- generation happens here, over the run's own frozen member rows, which did not
-- carry country, age, coordinates or preferences -- so it could not rule
-- anything out cheaply and asked the eligibility function about every pair.
-- That is why lifting the timeout let the snapshot finish at 34,573 candidates
-- rather than 12,105: the filtering was somewhere else entirely.
--
-- Those columns are now frozen alongside the rest of the member's row, so the
-- comparison happens once per pair on data already to hand, and the run stays
-- reproducible: it reads the snapshot, never the live tables.
--
-- Two helpers keep the rules in one place rather than copied into a window
-- function: whether a pair is worth asking about, and how far apart two people
-- are by the cheap measure used purely for ranking.

alter table halal_mode_private.matching_run_member_snapshots
  add column if not exists country text,
  add column if not exists relocation text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists age integer,
  add column if not exists min_age integer,
  add column if not exists max_age integer,
  add column if not exists max_distance_km integer,
  add column if not exists preferred_countries text[],
  add column if not exists must_have jsonb;

-- Cheap closeness, for ranking only. Years of age gap plus a rough distance in
-- units of 100km, equirectangular rather than great-circle: at these distances
-- the difference cannot change who is worth a proper look, and it costs one
-- cosine instead of a trigonometric distance.
create or replace function halal_mode_private.pair_apartness(
  a halal_mode_private.matching_run_member_snapshots,
  b halal_mode_private.matching_run_member_snapshots
) returns double precision
language sql
immutable
as $fn$
  select coalesce(abs(a.age - b.age), 0)::double precision
    + coalesce(
        sqrt(
          pow((b.latitude - a.latitude) * 111.0, 2)
          + pow((b.longitude - a.longitude) * 111.0
                * cos(radians((a.latitude + b.latitude) / 2)), 2)
        ) / 100.0, 0);
$fn$;

-- Worth asking the authority about. Country is universal and reciprocal; age
-- and distance bite only where that member marked them a must-have, because an
-- unmarked range means "ideally" and excluding on it would quietly delete valid
-- people. Distance uses a box around the circle, which can over-include but
-- never wrongly exclude.
create or replace function halal_mode_private.snapshot_pair_is_plausible(
  a halal_mode_private.matching_run_member_snapshots,
  b halal_mode_private.matching_run_member_snapshots
) returns boolean
language sql
stable
set search_path = pg_catalog, public, halal_mode_private
as $fn$
  select
    (
      lower(btrim(a.country)) = lower(btrim(b.country))
      or (a.relocation in ('open', 'willing_abroad')
        and (coalesce(array_length(a.preferred_countries, 1), 0) = 0
          or exists (select 1 from unnest(a.preferred_countries) x(c)
                     where lower(btrim(x.c)) = lower(btrim(b.country)))))
    )
    and (
      lower(btrim(b.country)) = lower(btrim(a.country))
      or (b.relocation in ('open', 'willing_abroad')
        and (coalesce(array_length(b.preferred_countries, 1), 0) = 0
          or exists (select 1 from unnest(b.preferred_countries) x(c)
                     where lower(btrim(x.c)) = lower(btrim(a.country)))))
    )
    and (not halal_mode_private.is_must_have(a.must_have, 'age')
         or b.age between a.min_age and a.max_age)
    and (not halal_mode_private.is_must_have(b.must_have, 'age')
         or a.age between b.min_age and b.max_age)
    and (not halal_mode_private.is_must_have(a.must_have, 'distance')
         or (abs(b.latitude - a.latitude) <= a.max_distance_km / 111.0
             and abs(b.longitude - a.longitude)
                 <= a.max_distance_km / (111.0 * greatest(cos(radians(a.latitude)), 0.01))))
    and (not halal_mode_private.is_must_have(b.must_have, 'distance')
         or (abs(a.latitude - b.latitude) <= b.max_distance_km / 111.0
             and abs(a.longitude - b.longitude)
                 <= b.max_distance_km / (111.0 * greatest(cos(radians(b.latitude)), 0.01))));
$fn$;

create or replace function public.matching_run_start_service(
  p_algorithm_version text,
  p_config_version integer,
  p_seed bigint,
  p_mode text,
  p_cycle_date date,
  p_evaluated_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run_id uuid;
  v_window_days integer;
  v_window_offset integer;
  v_window_starts_on date;
  v_window_ends_on date;
  v_pool_member_count integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching run creation requires service role'
      using errcode = '42501';
  end if;
  if nullif(btrim(p_algorithm_version), '') is null
     or length(p_algorithm_version) > 100
     or p_seed is null
     or p_cycle_date is null
     or p_evaluated_at is null then
    raise exception 'A complete matching run context is required'
      using errcode = '22023';
  end if;
  if (p_evaluated_at at time zone 'Asia/Riyadh')::date is distinct from p_cycle_date then
    raise exception 'Matching evaluation time must fall on the cycle date in Riyadh'
      using errcode = '22023';
  end if;
  if p_mode not in ('live', 'shadow') then
    raise exception 'Matching mode must be live or shadow'
      using errcode = '22023';
  end if;
  if p_config_version is distinct from
       halal_mode_private.active_matching_config_version() then
    raise exception 'Matching run must use the active configuration version'
      using errcode = '22023';
  end if;

  select (params ->> 'exposure_window_rounds')::integer
  into v_window_days
  from halal_mode_private.matching_config
  where version = p_config_version;
  if v_window_days is null or v_window_days < 1 then
    raise exception 'Matching exposure window configuration is invalid'
      using errcode = '22023';
  end if;

  -- Fixed, non-overlapping N-day calendar windows anchored to 1970-01-01.
  -- The seed never affects fairness accounting, and every run for one cycle
  -- receives the same dates regardless of when or in which mode it starts.
  v_window_offset := mod(p_cycle_date - date '1970-01-01', v_window_days);
  if v_window_offset < 0 then
    v_window_offset := v_window_offset + v_window_days;
  end if;
  v_window_starts_on := p_cycle_date - v_window_offset;
  v_window_ends_on := v_window_starts_on + (v_window_days - 1);

  insert into halal_mode_private.matching_runs (
    algorithm_version, config_version, seed, mode, cycle_date, time_zone,
    window_starts_on, window_ends_on, rounds_elapsed_in_window,
    evaluated_at, pool_member_count
  ) values (
    btrim(p_algorithm_version), p_config_version, p_seed, p_mode,
    p_cycle_date, 'Asia/Riyadh', v_window_starts_on, v_window_ends_on,
    v_window_offset + 1, p_evaluated_at, 0
  ) returning id into v_run_id;

  insert into halal_mode_private.matching_run_member_snapshots (
    run_id, user_id, gender, tier, times_shown, times_kept,
    rounds_since_last_mutual, rounds_since_last_served,
    exposures_in_window, introductions_per_round,
    country, relocation, latitude, longitude, age,
    min_age, max_age, max_distance_km, preferred_countries, must_have
  )
  select
    v_run_id,
    pool.id,
    pool.gender,
    pool.tier,
    pool.qualified_exposures::integer,
    pool.times_picked_by_others::integer,
    pool.rounds_since_last_mutual::integer,
    pool.rounds_since_last_served::integer,
    (
      select count(*)::integer
      from public.introductions i
      join public.rounds r on r.id = i.round_id
      where i.viewer_id = pool.id
        and (r.opens_at at time zone 'Asia/Riyadh')::date
          between v_window_starts_on and p_cycle_date
    ),
    pool.introductions_per_round::integer,
    -- Frozen alongside the rest of the member's row so candidate generation can
    -- rule pairs out by comparing columns, without reaching back to live tables
    -- and without re-reading the same rows once per pair.
    pool.country,
    pool.relocation,
    pool.latitude,
    pool.longitude,
    pool.age,
    pool.min_age,
    pool.max_age,
    pool.max_distance_km,
    pool.preferred_countries,
    pool.must_have
  from halal_mode_private.matching_pool pool;
  get diagnostics v_pool_member_count = row_count;

  update halal_mode_private.matching_runs
  set pool_member_count = v_pool_member_count
  where id = v_run_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'seed', p_seed,
    'cycle_date', p_cycle_date,
    'time_zone', 'Asia/Riyadh',
    'window_starts_on', v_window_starts_on,
    'window_ends_on', v_window_ends_on,
    'rounds_elapsed_in_window', v_window_offset + 1,
    'evaluated_at', p_evaluated_at,
    'pool_member_count', v_pool_member_count
  );
end;
$$;

create or replace function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(
  p_run_id uuid,
  p_fail_limit bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_male_count bigint;
  v_female_count bigint;
  v_potential_edge_count bigint;
  v_candidate_edge_count bigint;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching snapshot preparation requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_fail_limit is null or p_fail_limit < 1 then
    raise exception 'A run id and positive candidate fail limit are required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 5701));
  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id
  for update;

  if v_run.id is null or v_run.cycle_date is null then
    raise exception 'A snapshot-capable matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'A finished matching run cannot prepare candidates'
      using errcode = '22023';
  end if;

  if v_run.candidate_snapshot_prepared_at is not null then
    if v_run.candidate_snapshot_fail_limit is distinct from p_fail_limit then
      raise exception 'A prepared matching snapshot cannot change its fail limit'
        using errcode = '40001';
    end if;
    if (select count(*)::bigint
        from halal_mode_private.matching_run_candidate_snapshots c
        where c.run_id = p_run_id) is distinct from v_run.candidate_edge_count then
      raise exception 'The prepared matching snapshot is inconsistent'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'candidate_edge_count', v_run.candidate_edge_count,
      'potential_edge_count', v_run.potential_edge_count
    );
  end if;

  if exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots c
    where c.run_id = p_run_id
  ) then
    raise exception 'Uncommitted candidate rows conflict with run state'
      using errcode = '55000';
  end if;
  if (select count(*)::integer
      from halal_mode_private.matching_run_member_snapshots m
      where m.run_id = p_run_id) is distinct from v_run.pool_member_count then
    raise exception 'The matching member snapshot is inconsistent'
      using errcode = '55000';
  end if;

  -- This count touches only the frozen member rows. It deliberately runs
  -- before the male/female cross join, eligibility checks, or compatibility
  -- calculation, so an unsafe pool fails without materializing candidates.
  select
    count(*) filter (where gender = 'male')::bigint,
    count(*) filter (where gender = 'female')::bigint
  into v_male_count, v_female_count
  from halal_mode_private.matching_run_member_snapshots
  where run_id = p_run_id;
  v_potential_edge_count := v_male_count * v_female_count;

  if v_potential_edge_count > p_fail_limit then
    raise exception 'Potential candidate edge count % exceeds fail limit %',
      v_potential_edge_count, p_fail_limit
      using errcode = '54000';
  end if;

  insert into halal_mode_private.matching_run_candidate_snapshots (
    run_id, user_low, user_high, compat_low_to_high, compat_high_to_low,
    pair_times_shown, pair_first_score, pair_last_score,
    cooldown_until, retired_at
  )
  select
    p_run_id,
    least(m.user_id, f.user_id),
    greatest(m.user_id, f.user_id),
    halal_mode_private.compatibility(
      least(m.user_id, f.user_id), greatest(m.user_id, f.user_id)
    ),
    halal_mode_private.compatibility(
      greatest(m.user_id, f.user_id), least(m.user_id, f.user_id)
    ),
    coalesce(pe.times_shown, 0),
    pe.first_reciprocal_score,
    pe.last_reciprocal_score,
    pe.cooldown_until,
    pe.retired_at
  from (
    -- Rule pairs out by comparing frozen columns before anything expensive is
    -- asked about them, then keep only each member's shortlist.
    --
    -- Measured at 432 members: 44,720 possible pairs, 34,575 after the cheap
    -- rules, 12,105 after a shortlist of forty each -- and the shortlist costs
    -- 164ms to build while the per-pair functions cost 1.71ms each. The
    -- filtering is free; asking about every pair is not.
    select ranked.male_id, ranked.female_id
    from (
      select
        m.user_id as male_id,
        f.user_id as female_id,
        row_number() over (
          partition by m.user_id
          order by halal_mode_private.pair_apartness(m, f), f.user_id
        ) as his_rank,
        row_number() over (
          partition by f.user_id
          order by halal_mode_private.pair_apartness(m, f), m.user_id
        ) as her_rank
      from halal_mode_private.matching_run_member_snapshots m
      join halal_mode_private.matching_run_member_snapshots f
        on f.run_id = m.run_id and f.gender = 'female'
      where m.run_id = p_run_id
        and m.gender = 'male'
        and halal_mode_private.snapshot_pair_is_plausible(m, f)
    ) ranked
    -- A union, not an intersection: a pair survives if it is on either
    -- member's shortlist, so being unpopular by the cheap measure never puts
    -- somebody beyond the reach of a person who would rank them highly.
    where ranked.his_rank <= 40 or ranked.her_rank <= 40
  ) pair
  join halal_mode_private.matching_run_member_snapshots m
    on m.run_id = p_run_id and m.user_id = pair.male_id
  join halal_mode_private.matching_run_member_snapshots f
    on f.run_id = p_run_id and f.user_id = pair.female_id
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = least(m.user_id, f.user_id)
   and pe.user_high = greatest(m.user_id, f.user_id)
  where halal_mode_private.matching_pair_is_eligible(
      m.user_id, f.user_id, v_run.evaluated_at, v_run.config_version
    );
  get diagnostics v_candidate_edge_count = row_count;

  update halal_mode_private.matching_runs
  set candidate_snapshot_prepared_at = clock_timestamp(),
      candidate_snapshot_fail_limit = p_fail_limit,
      candidate_edge_count = v_candidate_edge_count,
      potential_edge_count = v_potential_edge_count
  where id = p_run_id;

  return jsonb_build_object(
    'candidate_edge_count', v_candidate_edge_count,
    'potential_edge_count', v_potential_edge_count
  );
end;
$$;
