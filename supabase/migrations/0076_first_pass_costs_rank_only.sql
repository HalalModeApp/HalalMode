-- The first pass costs rank. The second one also costs time.
--
-- 0070 had it the other way round: the first pass hid the pair for months and
-- cost nothing afterwards. That is backwards for a signal read off behaviour.
-- One quick scroll past somebody is worth a nudge, not a disappearance — and
-- if it really was a no, a lower rank means they simply stop outranking people
-- who were never turned down. Say it twice and the months follow.
--
-- Nobody vanishes immediately either way: repeat_cooldown_days already holds
-- any pair that has been shown for a fortnight, passed or not, so a first pass
-- lands on top of that rather than instead of it.
--
-- How the ban is expressed
--
-- Four places treat an `explicit_pass` row as "hold this pair out": the
-- candidate query, the eligibility gate, the plan validator and the finaliser.
-- They have to agree — if the gate admits a pair the validator rejects, the
-- round is thrown away — so rather than edit four filters in step, the decision
-- written is what changes. `explicit_pass` in introduction_selections now means
-- "a pass currently holding this pair out", which is exactly what those four
-- already read it as. The durable record of how many times somebody was passed
-- lives on the pair, where a fact about a pair belongs.
--
-- So: first pass records a release and increments the pair's count. Second pass
-- records an explicit_pass, which the existing filters hold out until the
-- cooldown expires.

create or replace function public.pass_introduction(p_introduction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_viewer uuid := auth.uid();
  v_introduction introductions%rowtype;
  v_ban_after int;
  v_passes int;
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform halal_mode_private.require_current_legal_consents(v_viewer);

  -- Same gate as release_introduction: the member's own live, unsubmitted
  -- round. A pass cannot be applied to someone else's card, or after the fact.
  select i.* into v_introduction
  from introductions i
  join rounds r on r.id = i.round_id
  where i.id = p_introduction_id
    and i.viewer_id = v_viewer
    and r.user_id = v_viewer
    and r.submitted_at is null
    and r.expires_at > now();

  if v_introduction is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  v_ban_after := coalesce(
    (halal_mode_private.active_matching_config() ->> 'explicit_pass_ban_after')::int,
    2
  );

  -- Counted here rather than when a ban expires, because the count is now what
  -- carries the penalty and it has to apply from the first pass onward.
  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, explicit_pass_count
  )
  values (
    least(v_viewer, v_introduction.subject_id),
    greatest(v_viewer, v_introduction.subject_id),
    1
  )
  on conflict (user_low, user_high) do update
    set explicit_pass_count = pe.explicit_pass_count + 1
  returning pe.explicit_pass_count into v_passes;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (
    v_introduction.id, v_viewer, v_introduction.subject_id,
    case
      when v_passes >= v_ban_after then 'explicit_pass'::selection_decision
      else 'released'::selection_decision
    end
  )
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = excluded.decision,
        decided_at = now()
    where introduction_selections.viewer_id = v_viewer;
end;
$$;

comment on function public.pass_introduction(uuid) is
  'Records a deliberate pass. The first costs the pair rank; from the second it also holds them apart for explicit_pass_cooldown_days. Never closes a pair for good — only a member does that, by hiding someone. The subject is never told.';

revoke all on function public.pass_introduction(uuid) from public, anon;
grant execute on function public.pass_introduction(uuid) to authenticated;

-- Expiry now only lifts the ban. The count was banked when the pass was made,
-- so incrementing here as well would charge the same pass twice.
create or replace function halal_mode_private.expire_explicit_passes()
returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cooldown_days int := coalesce(
    (halal_mode_private.active_matching_config() ->> 'explicit_pass_cooldown_days')::int,
    90
  );
  expired int := 0;
begin
  update public.introduction_selections s
  set decision = 'released'
  where s.decision = 'explicit_pass'
    and s.decided_at < now() - make_interval(days => cooldown_days);

  get diagnostics expired = row_count;
  return expired;
end;
$$;

comment on function halal_mode_private.expire_explicit_passes() is
  'Lifts the ban on passes older than the cooldown. The rank penalty stays, carried by the pair count. Idempotent.';

revoke all on function halal_mode_private.expire_explicit_passes() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Configuration
--
-- `explicit_pass_ban_after` is how many passes it takes before one also holds
-- the pair apart. At 2 the first is a rank penalty alone. Restated whole
-- rather than as a diff, per 0068.
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
  'First pass costs rank only; the ban starts at the second.',
  now();
