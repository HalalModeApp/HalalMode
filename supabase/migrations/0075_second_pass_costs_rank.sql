-- Passing twice costs rank. Only a person can close a pair for good.
--
-- 0070 retired a pair automatically on the second pass, which made the
-- algorithm the thing that decided somebody was never coming back. That is the
-- one decision it should not be making on its own. A pass is inferred from
-- behaviour — it is a good guess, confirmed once, but still a guess — and two
-- good guesses should not add up to a permanent verdict.
--
-- So the second pass does what a second no should: it costs them rank, and it
-- buys another few months of quiet. If somebody is to be gone for good, the
-- member says so, in as many words, through "I recognise this person".
--
-- The pair still cannot run forever: max_pair_appearances caps any pair at
-- three showings however they went. That cap is about repetition, not about
-- judgement, which is the difference that matters here.

-- ---------------------------------------------------------------------------
-- The count has to reach the scorer
--
-- It already lives on pair_exposure, but the planner reads a per-run snapshot
-- rather than the live table, so a column that stops at the snapshot boundary
-- is a column the ranking cannot see.
-- ---------------------------------------------------------------------------

alter table halal_mode_private.matching_run_candidate_snapshots
  add column if not exists explicit_pass_count smallint not null default 0;

comment on column halal_mode_private.matching_run_candidate_snapshots.explicit_pass_count is
  'Deliberate passes this pair has accumulated. From the second onward the reciprocal score is multiplied down by repeat_pass_penalty.';

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
    cooldown_until, retired_at, explicit_pass_count
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
    pe.retired_at,
    coalesce(pe.explicit_pass_count, 0)
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

-- The reader end of the same pipe. `create or replace` cannot change a
-- function's result columns, so this one has to go and come back.
drop function if exists public.matching_candidate_edges_service(uuid, uuid, uuid, integer);

create function public.matching_candidate_edges_service(
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
  pair_retired_at timestamptz,
  pair_explicit_pass_count integer
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
    c.retired_at,
    c.explicit_pass_count::integer
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

revoke all on function public.matching_candidate_edges_service(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.matching_candidate_edges_service(uuid, uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Expiry, without the verdict
--
-- Same as 0070 minus the retirement: count the pass, lift the ban, leave the
-- pair open. The count is what the scorer reads, so a second pass keeps costing
-- them rank long after the ban has lifted — which is the difference between
-- "we heard you" and "they are gone".
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.expire_explicit_passes()
returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb := halal_mode_private.active_matching_config();
  cooldown_days int := coalesce((cfg ->> 'explicit_pass_cooldown_days')::int, 90);
  expired int := 0;
begin
  -- Three statements, not one chained CTE: a data-modifying CTE is invisible to
  -- the rest of its own statement, so anything reading rows the same statement
  -- had just inserted would silently skip every pair with no exposure row yet.

  -- Aggregated first, because a pair where both members passed each other
  -- yields two rows for one pair and ON CONFLICT cannot touch a row twice.
  -- Counting both is also right: mutual passing is two noes, not one.
  with due as (
    select least(s.viewer_id, s.subject_id) as user_low,
           greatest(s.viewer_id, s.subject_id) as user_high,
           count(*)::smallint as passes
    from public.introduction_selections s
    where s.decision = 'explicit_pass'
      and s.decided_at < now() - make_interval(days => cooldown_days)
    group by 1, 2
  )
  insert into halal_mode_private.pair_exposure as pe (user_low, user_high, explicit_pass_count)
  select user_low, user_high, passes from due
  on conflict (user_low, user_high) do update
    set explicit_pass_count = pe.explicit_pass_count + excluded.explicit_pass_count;

  -- now() is the transaction timestamp, so this is exactly the set just counted.
  update public.introduction_selections s
  set decision = 'released'
  where s.decision = 'explicit_pass'
    and s.decided_at < now() - make_interval(days => cooldown_days);

  get diagnostics expired = row_count;
  return expired;
end;
$$;

comment on function halal_mode_private.expire_explicit_passes() is
  'Lifts the ban on passes older than the cooldown and banks the count against the pair, which costs it rank from the second pass onward. Never retires a pair — only a member can do that, by hiding someone. Idempotent.';

revoke all on function halal_mode_private.expire_explicit_passes() from public, anon, authenticated;

-- Pairs 0070 retired on a second pass, before this migration decided that was
-- the algorithm's call to make. There should be none in practice — nothing had
-- written a pass until 0073 — but a reason this specific is safe to undo, and
-- leaving them closed would strand exactly the people this change is about.
update halal_mode_private.pair_exposure
set retired_at = null, retired_reason = null
where retired_reason = 'passed_twice';

-- ---------------------------------------------------------------------------
-- Configuration
--
-- `explicit_pass_retire_after` goes: nothing counts passes toward a verdict
-- any more. `repeat_pass_penalty` replaces it — what the second pass costs,
-- applied to the pair score and compounding if it somehow happens again.
-- Restated whole rather than as a diff, per 0068.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.matching_config_params_valid(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog as $$
declare
  weight_sum numeric;
  criterion_sum numeric;
  key text;
  numeric_keys text[] := array[
    'w_compat', 'w_appeal', 'w_pair', 'exposure_full_confidence', 'p_min', 'p_max',
    'imbalance_lambda', 'min_reciprocal_score', 'exposure_boost_weight',
    'no_match_boost_weight', 'boost_cap', 'quality_band_width',
    'exposure_target_multiplier', 'exposure_window_rounds', 'no_match_rounds_full',
    'repeat_decay', 'repeat_cooldown_days', 'max_pair_appearances',
    'repeat_abandon_drop', 'rotation_min_set_size', 'repair_time_budget_ms',
    'warn_round_latency_ms', 'fail_round_latency_ms', 'warn_edges_after_filter',
    'fail_edges_after_filter', 'warn_peak_memory_bytes', 'fail_peak_memory_bytes',
    'min_segment_sample',
    -- Graded scoring, exploration and tuning.
    'distance_free_km', 'sect_mismatch_score',
    'exploration_rate', 'exploration_min_slot',
    'max_weight_step', 'min_criterion_weight', 'max_criterion_weight',
    'tuning_min_samples', 'tuning_gain',
    -- How long an explicit pass holds before the pair may be reconsidered,
    -- and how many passes settle it for good.
    'explicit_pass_cooldown_days', 'repeat_pass_penalty',
    -- Composition. These were read by the allocator but never lived here, so
    -- they could not be tuned without a deploy — and, worse, their absence made
    -- this whole payload unreadable to resolveStoredConfig().
    'reach_gap_threshold', 'max_reach_edges', 'reach_bias_floor'
  ];
  string_keys text[] := array['reciprocal_combiner', 'allocator'];
  boolean_keys text[] := array['rotation_enabled', 'tuning_enabled'];
  object_keys text[] := array['weights', 'falloff'];
  expected_keys text[];
begin
  if jsonb_typeof(p) is distinct from 'object' then
    return false;
  end if;

  foreach key in array numeric_keys loop
    if jsonb_typeof(p -> key) is distinct from 'number' then return false; end if;
  end loop;
  foreach key in array string_keys loop
    if jsonb_typeof(p -> key) is distinct from 'string' then return false; end if;
  end loop;
  foreach key in array boolean_keys loop
    if jsonb_typeof(p -> key) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach key in array object_keys loop
    if jsonb_typeof(p -> key) is distinct from 'object' then return false; end if;
  end loop;

  -- An unknown key is still rejected. That strictness is what makes this table a
  -- contract rather than a bag, and it is exactly why this migration has to
  -- teach the validator before it can write anything.
  expected_keys := numeric_keys || string_keys || boolean_keys || object_keys;
  if exists (
    select 1 from jsonb_object_keys(p) as supplied(key_name)
    where not (supplied.key_name = any(expected_keys))
  ) then
    return false;
  end if;

  -- Criterion weights must be non-negative and together describe shares of one
  -- whole. The tuner renormalises after every adjustment; this is what makes
  -- that a requirement rather than a convention.
  if exists (
    select 1 from jsonb_each(p -> 'weights') as w(name, value)
    where jsonb_typeof(w.value) is distinct from 'number'
       or (w.value #>> '{}')::numeric < 0
  ) then
    return false;
  end if;
  select sum((value #>> '{}')::numeric) into criterion_sum from jsonb_each(p -> 'weights');
  if criterion_sum is null or abs(criterion_sum - 1) > 0.001 then
    return false;
  end if;

  -- Falloffs are per-step proximity along an ordered scale, so strictly inside
  -- (0, 1]: zero would make a neighbour a stranger, and above one would reward
  -- distance.
  if exists (
    select 1 from jsonb_each(p -> 'falloff') as f(name, value)
    where jsonb_typeof(f.value) is distinct from 'number'
       or (f.value #>> '{}')::numeric <= 0
       or (f.value #>> '{}')::numeric > 1
  ) then
    return false;
  end if;

  weight_sum := (p ->> 'w_compat')::numeric
    + (p ->> 'w_appeal')::numeric
    + (p ->> 'w_pair')::numeric;
  return coalesce((p ->> 'w_compat')::numeric >= 0
    and (p ->> 'w_appeal')::numeric >= 0
    and (p ->> 'w_pair')::numeric >= 0
    and abs(weight_sum - 1) <= 0.000000001
    and (p ->> 'exposure_full_confidence')::numeric >= 1
    and (p ->> 'p_min')::numeric >= 0
    and (p ->> 'p_min')::numeric < (p ->> 'p_max')::numeric
    and (p ->> 'p_max')::numeric <= 1
    and (p ->> 'reciprocal_combiner') in ('geometric', 'arithmetic', 'min')
    and (p ->> 'imbalance_lambda')::numeric between 0 and 1
    and (p ->> 'min_reciprocal_score')::numeric between 0 and 1
    and (p ->> 'exposure_boost_weight')::numeric >= 0
    and (p ->> 'no_match_boost_weight')::numeric >= 0
    and (p ->> 'boost_cap')::numeric between 0 and 1
    and (p ->> 'quality_band_width')::numeric > 0
    and (p ->> 'quality_band_width')::numeric <= 1
    and (p ->> 'exposure_target_multiplier')::numeric > 0
    and (p ->> 'exposure_window_rounds')::numeric >= 1
    and (p ->> 'no_match_rounds_full')::numeric >= 1
    and (p ->> 'repeat_decay')::numeric > 0
    and (p ->> 'repeat_decay')::numeric <= 1
    and (p ->> 'repeat_cooldown_days')::numeric >= 0
    and (p ->> 'max_pair_appearances')::numeric >= 1
    and (p ->> 'repeat_abandon_drop')::numeric between 0 and 1
    and (p ->> 'rotation_min_set_size')::numeric >= 1
    and (p ->> 'repair_time_budget_ms')::numeric >= 0
    -- Both allocators are legitimate; the anchored one is compared in shadow.
    and (p ->> 'allocator') in ('greedy_global_v1', 'anchored_maxmin_v1')
    and (p ->> 'warn_round_latency_ms')::numeric >= 0
    and (p ->> 'fail_round_latency_ms')::numeric >= (p ->> 'warn_round_latency_ms')::numeric
    and (p ->> 'warn_edges_after_filter')::numeric >= 0
    and (p ->> 'fail_edges_after_filter')::numeric >= (p ->> 'warn_edges_after_filter')::numeric
    and (p ->> 'warn_peak_memory_bytes')::numeric >= 0
    and (p ->> 'fail_peak_memory_bytes')::numeric >= (p ->> 'warn_peak_memory_bytes')::numeric
    and (p ->> 'min_segment_sample')::numeric >= 0
    -- Exploration is a share of slots, and never reaches a first choice.
    and (p ->> 'exploration_rate')::numeric between 0 and 1
    and (p ->> 'exploration_min_slot')::numeric >= 2
    and (p ->> 'distance_free_km')::numeric >= 0
    and (p ->> 'sect_mismatch_score')::numeric between 0 and 1
    -- Tuning bounds. A step wider than the range it moves within would make the
    -- bound meaningless.
    and (p ->> 'max_weight_step')::numeric > 0
    and (p ->> 'min_criterion_weight')::numeric >= 0
    and (p ->> 'max_criterion_weight')::numeric > (p ->> 'min_criterion_weight')::numeric
    and (p ->> 'tuning_min_samples')::numeric >= 1
    and (p ->> 'tuning_gain')::numeric >= 0
    -- A zero cooldown would make a pass meaningless; one pass settling the
    -- pair for good would make it permanent, which is what this replaces.
    and (p ->> 'explicit_pass_cooldown_days')::numeric >= 1
    -- Strictly inside (0, 1]: at 1 a second pass would cost nothing, and at 0
    -- it would be a permanent removal wearing a multiplier's clothes.
    and (p ->> 'repeat_pass_penalty')::numeric > 0
    and (p ->> 'repeat_pass_penalty')::numeric <= 1
    -- Never zero: nobody is stopped from aiming high, only from spending every
    -- slot doing it.
    and (p ->> 'max_reach_edges')::numeric >= 1
    and (p ->> 'reach_gap_threshold')::numeric between 0 and 1
    and (p ->> 'reach_bias_floor')::numeric between 0 and 1
  , false);
end;
$$;

revoke all on function halal_mode_private.matching_config_params_valid(jsonb)
  from public, anon, authenticated;

insert into halal_mode_private.matching_config (version, params, notes, activated_at)
select
  coalesce((select max(version) from halal_mode_private.matching_config), 0) + 1,
  $config${
  "allocator": "greedy_global_v1",
  "boost_cap": 0.25,
  "distance_free_km": 25,
  "explicit_pass_cooldown_days": 90,
  "exploration_min_slot": 4,
  "exploration_rate": 0.1,
  "exposure_boost_weight": 0.3,
  "exposure_full_confidence": 15,
  "exposure_target_multiplier": 1,
  "exposure_window_rounds": 7,
  "fail_edges_after_filter": 8000000,
  "fail_peak_memory_bytes": 536870912,
  "fail_round_latency_ms": 120000,
  "falloff": {
    "build": 0.88,
    "children": 0.65,
    "practice": 0.7,
    "relocation": 0.8,
    "timeline": 0.85
  },
  "imbalance_lambda": 0,
  "max_criterion_weight": 0.35,
  "max_pair_appearances": 3,
  "max_reach_edges": 2,
  "max_weight_step": 0.02,
  "min_criterion_weight": 0.01,
  "min_reciprocal_score": 0.15,
  "min_segment_sample": 30,
  "no_match_boost_weight": 0.2,
  "no_match_rounds_full": 8,
  "p_max": 0.98,
  "p_min": 0.02,
  "quality_band_width": 0.025,
  "reach_bias_floor": 0.7,
  "reach_gap_threshold": 0.25,
  "reciprocal_combiner": "geometric",
  "repair_time_budget_ms": 2000,
  "repeat_abandon_drop": 0.35,
  "repeat_cooldown_days": 14,
  "repeat_decay": 0.7,
  "repeat_pass_penalty": 0.5,
  "rotation_enabled": true,
  "rotation_min_set_size": 3,
  "sect_mismatch_score": 0.15,
  "tuning_enabled": false,
  "tuning_gain": 0.5,
  "tuning_min_samples": 200,
  "w_appeal": 0.3,
  "w_compat": 0.55,
  "w_pair": 0.15,
  "warn_edges_after_filter": 2000000,
  "warn_peak_memory_bytes": 268435456,
  "warn_round_latency_ms": 30000,
  "weights": {
    "age": 0.15,
    "build": 0.11,
    "children": 0.14,
    "distance": 0.1,
    "height": 0.09,
    "languages": 0.02,
    "practice": 0.2,
    "relocation": 0.08,
    "timeline": 0.11
  }
}$config$::jsonb,
  'A second pass costs rank instead of closing the pair.',
  now();
