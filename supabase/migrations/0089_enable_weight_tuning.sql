-- Let the machine tune the weights, and keep its work separable from yours.
--
-- The tuner has existed since 0067 and has never run: tuning_enabled was false
-- and nothing anywhere called tune_matching_weights(). The fifth thing in this
-- schema found fully built and never invoked.
--
-- Turning it on raises a question the versioning could not previously answer.
-- Every adjustment inserts a whole new configuration version, so once this is
-- running the history becomes a stream in which "a pass now costs a month" and
-- "criterion weight moved by 0.003" are the same kind of object. Storage is not
-- the issue — a version is about two kilobytes, so a thousand of them is two
-- megabytes. Legibility is. The point of versioning was to answer what the
-- settings were *and why*, and the why drowns at a few hundred rows.
--
-- One column fixes it. The tuner's own audit trail already exists in
-- matching_weight_adjustments, with the criterion, both weights, the observed
-- lift and the sample size, so nothing is lost by being able to filter these
-- out; what is gained is being able to ask which settings a person chose.

alter table halal_mode_private.matching_config
  add column if not exists machine_tuned boolean not null default false;

comment on column halal_mode_private.matching_config.machine_tuned is
  'True when the tuner produced this version rather than a person. Every version so far is a policy decision, so the default is false and the existing rows keep it.';

-- Version numbers came from `max(version) + 1` computed in the caller, which is
-- a race as soon as two things can insert: a policy change and a tuning run at
-- the same moment compute the same number and one fails on the primary key.
-- A sequence removes the arithmetic from the caller entirely.
create sequence if not exists halal_mode_private.matching_config_version_seq
  owned by halal_mode_private.matching_config.version;

select setval(
  'halal_mode_private.matching_config_version_seq',
  (select coalesce(max(version), 1) from halal_mode_private.matching_config)
);

alter table halal_mode_private.matching_config
  alter column version set default nextval('halal_mode_private.matching_config_version_seq');

create or replace function halal_mode_private.tune_matching_weights()
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb;
  weights jsonb;
  next_weights jsonb := '{}'::jsonb;
  from_version int;
  to_version int;
  max_step numeric;
  min_w numeric;
  max_w numeric;
  min_samples int;
  gain numeric;
  total numeric := 0;
  row_lift record;
  criterion text;
  old_w numeric;
  new_w numeric;
  moved int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Weight tuning requires service role' using errcode = '42501';
  end if;

  cfg := halal_mode_private.active_matching_config();
  from_version := halal_mode_private.active_matching_config_version();
  if coalesce((cfg ->> 'tuning_enabled')::boolean, false) is not true then
    return jsonb_build_object('skipped', 'tuning_disabled');
  end if;

  weights := coalesce(cfg -> 'weights', '{}'::jsonb);
  max_step := coalesce((cfg ->> 'max_weight_step')::numeric, 0.02);
  min_w := coalesce((cfg ->> 'min_criterion_weight')::numeric, 0.01);
  max_w := coalesce((cfg ->> 'max_criterion_weight')::numeric, 0.35);
  min_samples := coalesce((cfg ->> 'tuning_min_samples')::int, 200);
  gain := coalesce((cfg ->> 'tuning_gain')::numeric, 0.5);

  -- Start from the current weights; anything without enough evidence stays put.
  next_weights := weights;

  for row_lift in
    select * from halal_mode_private.criterion_lift()
  loop
    criterion := row_lift.criterion;
    if not (weights ? criterion) then continue; end if;
    if row_lift.sample_size < min_samples then continue; end if;

    old_w := (weights ->> criterion)::numeric;
    new_w := old_w * (1 + gain * row_lift.lift);

    -- Bounded in both senses: a limited move, inside a reviewed range.
    new_w := least(old_w + max_step, greatest(old_w - max_step, new_w));
    new_w := least(max_w, greatest(min_w, new_w));

    if abs(new_w - old_w) < 0.0005 then continue; end if;
    next_weights := next_weights || jsonb_build_object(criterion, round(new_w, 4));
    moved := moved + 1;
  end loop;

  if moved = 0 then
    return jsonb_build_object('skipped', 'no_criterion_had_enough_evidence');
  end if;

  -- Renormalise so the weights still describe shares of one whole.
  select sum((value #>> '{}')::numeric) into total from jsonb_each(next_weights);
  if total is null or total <= 0 then
    return jsonb_build_object('skipped', 'degenerate_weights');
  end if;
  select jsonb_object_agg(key, round(((value #>> '{}')::numeric / total), 4))
  into next_weights from jsonb_each(next_weights);

  -- The version comes from the sequence rather than max + 1, so a policy change
  -- landing at the same moment cannot collide with this one on the primary key.
  insert into halal_mode_private.matching_config (params, notes, activated_at, machine_tuned)
  values (
    cfg || jsonb_build_object('weights', next_weights),
    'Automatic weight adjustment from observed mutual first choices.',
    now(),
    true
  )
  returning version into to_version;

  for row_lift in select * from halal_mode_private.criterion_lift() loop
    if not (weights ? row_lift.criterion) then continue; end if;
    insert into halal_mode_private.matching_weight_adjustments (
      from_version, to_version, criterion, old_weight, new_weight,
      observed_lift, sample_size
    ) values (
      from_version, to_version, row_lift.criterion,
      (weights ->> row_lift.criterion)::numeric,
      (next_weights ->> row_lift.criterion)::numeric,
      row_lift.lift, row_lift.sample_size
    );
  end loop;

  return jsonb_build_object(
    'from_version', from_version,
    'to_version', to_version,
    'criteria_moved', moved,
    'weights', next_weights
  );
end;
$$;

-- Reachable from the generator. Private functions cannot be called through
-- PostgREST, and the tuner has to run somewhere it can be sequenced against
-- round generation rather than at an arbitrary moment: if a new version landed
-- between the generator reading the config and starting its run, the run would
-- be rejected for not using the active version.
create or replace function public.tune_matching_weights_service()
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.uid() is not null then
    raise exception 'Not available' using errcode = '42501';
  end if;
  return halal_mode_private.tune_matching_weights();
end;
$$;

comment on function public.tune_matching_weights_service() is
  'Runs the weight tuner. Called once per generation cycle, before the config is read, so a new version cannot appear mid-run. Returns a skip reason rather than raising when there is not enough evidence to move anything.';

revoke all on function public.tune_matching_weights_service()
  from public, anon, authenticated;
grant execute on function public.tune_matching_weights_service() to service_role;

-- ---------------------------------------------------------------------------
-- Configuration
--
-- tuning_enabled goes true. The guards that matter are already in place and
-- unchanged: 200 samples per criterion before anything moves, a 0.02 ceiling
-- on any single step, and a floor and ceiling on every weight. It cannot lurch.
--
-- No version number: the sequence assigns it now, which is the point.
-- Restated whole, per 0068.
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
    -- Repetition scaled to how plausible a mutual pick looks.
    'min_pair_appearances', 'min_repeat_cooldown_days',
    'max_repeat_cooldown_days', 'repeat_generous_score',
    'repeat_generosity_curve',
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
    'explicit_pass_ban_after', 'explicit_pass_first_cooldown_days',
    -- The one positive outcome: read at length, kept only for want of a slot.
    'soft_select_lift',
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
    and (p ->> 'min_pair_appearances')::numeric >= 1
    and (p ->> 'min_pair_appearances')::numeric <= (p ->> 'max_pair_appearances')::numeric
    and (p ->> 'min_repeat_cooldown_days')::numeric >= 1
    and (p ->> 'max_repeat_cooldown_days')::numeric >= (p ->> 'min_repeat_cooldown_days')::numeric
    -- At or below the floor the range inverts and every pair reads as
    -- maximally promising, which is the opposite of the intent.
    and (p ->> 'repeat_generous_score')::numeric > (p ->> 'min_reciprocal_score')::numeric
    and (p ->> 'repeat_generous_score')::numeric <= 1
    and (p ->> 'repeat_generosity_curve')::numeric > 0
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
    -- At 1 the very first pass would also ban, which is what this replaced.
    and (p ->> 'explicit_pass_ban_after')::numeric >= 2
    -- Longer than the ordinary repeat wait, or a pass would cost no time.
    and (p ->> 'explicit_pass_first_cooldown_days')::numeric
        > (p ->> 'max_repeat_cooldown_days')::numeric
    -- At 1 a soft select would mean nothing; it is a lift, never a penalty.
    and (p ->> 'soft_select_lift')::numeric > 1
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

insert into halal_mode_private.matching_config (params, notes, activated_at, machine_tuned)
values (
  $config${
  "allocator": "greedy_global_v1",
  "boost_cap": 0.25,
  "distance_free_km": 25,
  "explicit_pass_ban_after": 2,
  "explicit_pass_cooldown_days": 90,
  "explicit_pass_first_cooldown_days": 30,
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
  "max_pair_appearances": 5,
  "max_reach_edges": 2,
  "max_repeat_cooldown_days": 21,
  "max_weight_step": 0.02,
  "min_criterion_weight": 0.01,
  "min_pair_appearances": 2,
  "min_reciprocal_score": 0.15,
  "min_repeat_cooldown_days": 2,
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
  "repeat_generosity_curve": 2,
  "repeat_generous_score": 0.6,
  "repeat_pass_penalty": 0.5,
  "rotation_enabled": true,
  "rotation_min_set_size": 3,
  "sect_mismatch_score": 0.15,
  "soft_select_lift": 1.5,
  "tuning_enabled": true,
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
  'Weight tuning enabled, and run once per cycle by the generator.',
  now(),
  false
);

do $$
declare
  v_result jsonb;
  v_before int;
  v_after int;
begin
  assert (select count(*) from halal_mode_private.matching_config
          where machine_tuned) = 0,
    'every version up to now is a policy decision';
  assert (halal_mode_private.active_matching_config() ->> 'tuning_enabled')::boolean,
    'tuning should be on by the time this runs';

  select count(*) into v_before from halal_mode_private.matching_config;

  -- Run it for real. With no members there is no evidence, so it must decline
  -- rather than raise, and must not leave a version behind while declining.
  -- Those guards have existed since 0067 and have never once been executed.
  v_result := public.tune_matching_weights_service();
  assert v_result ? 'skipped',
    format('the tuner should decline with no evidence; it returned %s', v_result);

  select count(*) into v_after from halal_mode_private.matching_config;
  assert v_after = v_before,
    format('a declined tuning run must not insert a version; %s became %s', v_before, v_after);
end;
$$;
