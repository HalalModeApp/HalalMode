-- Reciprocal matching v1: deterministic run context and immutable snapshots.
--
-- A run now owns one frozen member set and one frozen candidate-edge set.
-- Pagination reads only that snapshot, so pages cannot drift as profiles,
-- preferences, connections, or exposure history change during generation.

alter table halal_mode_private.matching_runs
  add column if not exists cycle_date date,
  add column if not exists time_zone text,
  add column if not exists window_starts_on date,
  add column if not exists window_ends_on date,
  add column if not exists rounds_elapsed_in_window integer,
  add column if not exists evaluated_at timestamptz,
  add column if not exists pool_member_count integer,
  add column if not exists candidate_snapshot_prepared_at timestamptz,
  add column if not exists candidate_snapshot_fail_limit bigint,
  add column if not exists candidate_edge_count bigint,
  add column if not exists potential_edge_count bigint;

alter table halal_mode_private.matching_runs
  drop constraint if exists matching_runs_snapshot_context_check;
alter table halal_mode_private.matching_runs
  add constraint matching_runs_snapshot_context_check check (
    (cycle_date is null
      and time_zone is null
      and window_starts_on is null
      and window_ends_on is null
      and rounds_elapsed_in_window is null
      and evaluated_at is null
      and pool_member_count is null)
    or
    (cycle_date is not null
      and time_zone = 'Asia/Riyadh'
      and window_starts_on is not null
      and window_ends_on is not null
      and window_starts_on <= cycle_date
      and cycle_date <= window_ends_on
      and rounds_elapsed_in_window = cycle_date - window_starts_on + 1
      and rounds_elapsed_in_window > 0
      and evaluated_at is not null
      and pool_member_count >= 0)
  );

alter table halal_mode_private.matching_runs
  drop constraint if exists matching_runs_candidate_snapshot_check;
alter table halal_mode_private.matching_runs
  add constraint matching_runs_candidate_snapshot_check check (
    (candidate_snapshot_prepared_at is null
      and candidate_snapshot_fail_limit is null
      and candidate_edge_count is null
      and potential_edge_count is null)
    or
    (candidate_snapshot_prepared_at is not null
      and candidate_snapshot_fail_limit > 0
      and candidate_edge_count >= 0
      and potential_edge_count >= candidate_edge_count)
  );

create table halal_mode_private.matching_run_member_snapshots (
  run_id uuid not null references halal_mode_private.matching_runs(id) on delete cascade,
  -- Deliberately not a foreign key to profiles: deleting or editing source
  -- data must not mutate pages in an in-flight run. The final writer still
  -- revalidates current eligibility before any live or shadow output persists.
  user_id uuid not null,
  gender public.gender not null,
  tier public.membership_tier not null,
  times_shown integer not null,
  times_kept integer not null,
  rounds_since_last_mutual integer not null,
  rounds_since_last_served integer not null,
  exposures_in_window integer not null,
  introductions_per_round integer not null,
  primary key (run_id, user_id),
  check (times_shown >= 0 and times_kept >= 0),
  check (rounds_since_last_mutual >= 0 and rounds_since_last_served >= 0),
  check (exposures_in_window >= 0 and introductions_per_round > 0)
);

create table halal_mode_private.matching_run_candidate_snapshots (
  run_id uuid not null,
  user_low uuid not null,
  user_high uuid not null,
  compat_low_to_high numeric not null,
  compat_high_to_low numeric not null,
  pair_times_shown integer not null,
  pair_first_score numeric,
  pair_last_score numeric,
  cooldown_until timestamptz,
  retired_at timestamptz,
  primary key (run_id, user_low, user_high),
  foreign key (run_id, user_low)
    references halal_mode_private.matching_run_member_snapshots(run_id, user_id)
    on delete cascade,
  foreign key (run_id, user_high)
    references halal_mode_private.matching_run_member_snapshots(run_id, user_id)
    on delete cascade,
  check (user_low < user_high),
  check (compat_low_to_high between 0 and 1),
  check (compat_high_to_low between 0 and 1),
  check (pair_times_shown >= 0),
  check (pair_first_score is null or pair_first_score between 0 and 1),
  check (pair_last_score is null or pair_last_score between 0 and 1)
);

create index matching_run_candidate_page_idx
  on halal_mode_private.matching_run_candidate_snapshots
  (run_id, user_low, user_high);
create index matching_run_candidate_high_fk_idx
  on halal_mode_private.matching_run_candidate_snapshots
  (run_id, user_high);

revoke all on table
  halal_mode_private.matching_run_member_snapshots,
  halal_mode_private.matching_run_candidate_snapshots
from public, anon, authenticated, service_role;

comment on table halal_mode_private.matching_run_member_snapshots is
  'Immutable private member and fairness inputs captured once when a matching run starts.';
comment on table halal_mode_private.matching_run_candidate_snapshots is
  'Immutable private eligible candidate edges captured once per matching run and paged deterministically.';

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
    exposures_in_window, introductions_per_round
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
    pool.introductions_per_round::integer
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

revoke all on function public.matching_run_start_service(text, integer, bigint, text, date, timestamptz)
  from public, anon, authenticated;
grant execute on function public.matching_run_start_service(text, integer, bigint, text, date, timestamptz)
  to service_role;

create or replace function public.matching_candidate_snapshot_prepare_service(
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
  from halal_mode_private.matching_run_member_snapshots m
  join halal_mode_private.matching_run_member_snapshots f
    on f.run_id = m.run_id and f.gender = 'female'
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = least(m.user_id, f.user_id)
   and pe.user_high = greatest(m.user_id, f.user_id)
  where m.run_id = p_run_id
    and m.gender = 'male'
    and halal_mode_private.matching_pair_is_eligible(
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

revoke all on function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  to service_role;

create or replace function public.matching_candidate_edges_service(
  p_run_id uuid,
  p_after_low uuid default null,
  p_after_high uuid default null,
  p_page_size integer default 1000
) returns table (
  user_low uuid,
  user_high uuid,
  compat_low_to_high numeric,
  compat_high_to_low numeric,
  pair_times_shown integer,
  pair_first_score numeric,
  pair_last_score numeric,
  pair_cooldown_until timestamptz,
  pair_retired_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching candidates require service role'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'A matching run id is required' using errcode = '22023';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 1000 then
    raise exception 'Matching candidate page size must be between 1 and 1000'
      using errcode = '22023';
  end if;
  if (p_after_low is null) <> (p_after_high is null) then
    raise exception 'Both matching candidate cursors must be provided together'
      using errcode = '22023';
  end if;

  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id;
  if v_run.id is null or v_run.cycle_date is null then
    raise exception 'A snapshot-capable matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'A finished matching run cannot read candidates'
      using errcode = '22023';
  end if;
  if v_run.candidate_snapshot_prepared_at is null then
    raise exception 'Prepare the matching candidate snapshot before paging it'
      using errcode = '55000';
  end if;

  return query
  select
    c.user_low,
    c.user_high,
    c.compat_low_to_high,
    c.compat_high_to_low,
    c.pair_times_shown,
    c.pair_first_score,
    c.pair_last_score,
    c.cooldown_until,
    c.retired_at
  from halal_mode_private.matching_run_candidate_snapshots c
  where c.run_id = p_run_id
    and (
      p_after_low is null
      or c.user_low > p_after_low
      or (c.user_low = p_after_low and c.user_high > p_after_high)
    )
  order by c.user_low, c.user_high
  limit p_page_size;
end;
$$;

create or replace function public.matching_member_signals_service(p_run_id uuid)
returns table (
  user_id uuid,
  gender public.gender,
  tier public.membership_tier,
  times_shown integer,
  times_kept integer,
  rounds_since_last_mutual integer,
  rounds_since_last_served integer,
  exposures_in_window integer,
  introductions_per_round integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching member signals require service role'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'A matching run id is required' using errcode = '22023';
  end if;

  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id;
  if v_run.id is null or v_run.cycle_date is null then
    raise exception 'A snapshot-capable matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'A finished matching run cannot read member signals'
      using errcode = '22023';
  end if;
  if v_run.candidate_snapshot_prepared_at is null then
    raise exception 'Prepare the matching candidate snapshot before reading signals'
      using errcode = '55000';
  end if;

  return query
  select
    m.user_id,
    m.gender,
    m.tier,
    m.times_shown,
    m.times_kept,
    m.rounds_since_last_mutual,
    m.rounds_since_last_served,
    m.exposures_in_window,
    m.introductions_per_round
  from halal_mode_private.matching_run_member_snapshots m
  where m.run_id = p_run_id
  order by m.user_id;
end;
$$;

revoke all on function public.matching_candidate_edges_service(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.matching_member_signals_service(uuid)
  from public, anon, authenticated;
grant execute on function public.matching_candidate_edges_service(uuid, uuid, uuid, integer)
  to service_role;
grant execute on function public.matching_member_signals_service(uuid)
  to service_role;

-- The no-run-id overloads remain only for migration-era compatibility tests.
-- The generation pipeline must use the run-bound overloads above.
