-- A cooldown expiring makes a pair eligible, not due.
--
-- Two changes, and the first is the one that matters. Repetition now loses to
-- novelty outright: a pair nobody has met is allocated ahead of every pair that
-- has already been shown, whatever the scores say. Somebody a member has
-- already seen has already had their answer; a new face at a slightly lower
-- rank is worth more than a better score on a rerun. Repeats fill what is left
-- over, which in a healthy pool is very little.
--
-- That is enforced in the planner, where allocation happens. Nothing in SQL
-- needs to know: the cooldown here decides when a pair may be considered, and
-- the planner decides whether it actually gets a slot. Those were the same
-- thing when a cooldown expiring meant a showing; they are not any more.
--
-- The second change reserves the short waits for the top of the range instead
-- of handing them to everyone above average. The generosity curve was linear,
-- so a merely decent pair came back nearly as fast as a strong one. Squared, a
-- pair halfway up earns a quarter of the patience rather than half, and only
-- genuinely top pairs approach the two-day floor.
--
--   estimate   patience   wait      showings
--   0.15       0.00       21 days   2
--   0.30       0.11       19 days   2
--   0.45       0.44       13 days   3
--   0.60       1.00        2 days   5
--
-- The floor drops from three days to two, which only the top of the range ever
-- sees, and which now costs nothing anyway: reaching it means being eligible
-- sooner, not being shown sooner.


-- ---------------------------------------------------------------------------
-- Configuration
--
-- The curve is what reserves the short waits for the top rather than handing
-- them to everyone above average: squared, a pair halfway up the range earns
-- a quarter of the patience rather than half. Restated whole, per 0068.
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
    'explicit_pass_ban_after',
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
  "explicit_pass_ban_after": 2,
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
  'Only the top pairs earn a short wait; fresh pairs outrank every repeat.',
  now();
-- The SQL half of the curve. 0077 shipped this linear, and the assertion at the
-- foot of this migration is what noticed: the TypeScript gained an exponent and
-- this did not, which would have handed middling pairs a two-week head start
-- over what the planner believed they had earned.
create or replace function halal_mode_private.repeat_generosity(
  p_score numeric,
  p_config jsonb
) returns numeric
language sql
immutable
set search_path = pg_catalog as $$
  select case
    when p_score is null then 0
    when (p_config ->> 'repeat_generous_score')::numeric
         <= (p_config ->> 'min_reciprocal_score')::numeric then 1
    else power(
      greatest(0, least(1,
        (p_score - (p_config ->> 'min_reciprocal_score')::numeric)
        / ((p_config ->> 'repeat_generous_score')::numeric
           - (p_config ->> 'min_reciprocal_score')::numeric))),
      (p_config ->> 'repeat_generosity_curve')::numeric)
  end;
$$;

comment on function halal_mode_private.repeat_generosity(numeric, jsonb) is
  'How much patience a pair has earned, 0 to 1, curved so the short waits belong to the top of the range rather than to everyone above average. Mirrors repeatGenerosity() in src/matching/estimate.ts.';

revoke all on function halal_mode_private.repeat_generosity(numeric, jsonb)
  from public, anon, authenticated;


-- Same check as 0078, against the curve this migration installs. The numbers in
-- the table above are the TypeScript results for the same inputs; if the two
-- implementations of the curve ever part company, this is where it shows.
do $$
declare
  cfg jsonb := halal_mode_private.active_matching_config();
  low numeric := (cfg ->> 'min_reciprocal_score')::numeric;
  high numeric := (cfg ->> 'repeat_generous_score')::numeric;
begin
  assert halal_mode_private.repeat_generosity(low + (high - low) / 2, cfg) = 0.25,
    'halfway up the range should earn a quarter of the patience, not half';
  assert halal_mode_private.pair_cooldown_days(high, cfg) = 2,
    'a top pair should reach the two-day floor';
  assert halal_mode_private.pair_cooldown_days(low, cfg) = 21,
    'a pair at the floor should still wait three weeks';
  assert halal_mode_private.pair_cooldown_days(0.45, cfg) = 13,
    'a decent pair should wait closer to a weak one than to a strong one';
  assert halal_mode_private.pair_cooldown_days(0.30, cfg) = 19,
    'the curve should keep middling pairs well away from the floor';
end;
$$;
