-- Three strengths of "no", where there were two.
--
--   not selected this round   situational. Short cooldown, comes back.
--   explicit pass             a real no. Long cooldown, comes back eventually.
--   hidden                    permanent and mutual. Never comes back.
--
-- The middle one changes meaning here. `explicit_pass` was treated as permanent
-- everywhere it was checked, which is stronger than a member means by it: "I do
-- not want this person" is not "never show me this person again as long as I
-- live". People change, and so do the reasons — someone passed over while they
-- were still working out what they wanted is not the same person eighteen
-- months later, and neither is the member who passed.
--
-- Passing twice, months apart, is different. That is a considered answer, and
-- it retires the pair for good.
--
-- The third level is for recognising someone: a cousin, a colleague, a friend's
-- brother. That does mean never, and it has to run both ways — hiding your
-- cousin is worthless if you still turn up in theirs. It is silent in both
-- directions, and deliberately not a block, because nobody did anything wrong.

-- ---------------------------------------------------------------------------
-- Letting a pass expire
--
-- Rather than teach a cooldown to every place `explicit_pass` is checked — the
-- prefilter, the plan validator and the finaliser each hold their own copy —
-- the pass expires in the data. Once a stale pass is downgraded, every existing
-- check is correct without being touched, which is far safer than three
-- parallel edits to the functions that decide who meets whom.
-- ---------------------------------------------------------------------------

alter table halal_mode_private.pair_exposure
  add column if not exists explicit_pass_count smallint not null default 0;

comment on column halal_mode_private.pair_exposure.explicit_pass_count is
  'How many times this pair has been explicitly passed. Outlives the pass itself, so a second no can be treated as final.';

create or replace function halal_mode_private.expire_explicit_passes()
returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb := halal_mode_private.active_matching_config();
  cooldown_days int := coalesce((cfg ->> 'explicit_pass_cooldown_days')::int, 90);
  retire_after int := coalesce((cfg ->> 'explicit_pass_retire_after')::int, 2);
  expired int := 0;
begin
  -- Written as three statements rather than one chained CTE on purpose. A
  -- data-modifying CTE is invisible to the rest of its own statement, so a
  -- retirement pass reading rows the same statement had just inserted would
  -- silently skip every pair that had no exposure row yet — which is most of
  -- them.

  -- 1. Bank the count before the pass is downgraded. Aggregated first: a pair
  --    where both members passed each other yields two rows for one pair, and
  --    ON CONFLICT cannot touch the same row twice in one statement. Counting
  --    both is also right — mutual passing is two noes, not one.
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

  -- 2. Said no twice. Take the hint and stop offering. Guarded on retired_at so
  --    it fires once per pair and never overwrites an earlier reason.
  update halal_mode_private.pair_exposure
  set retired_at = now(),
      retired_reason = 'passed_twice'
  where explicit_pass_count >= retire_after
    and retired_at is null;

  -- 3. Release the pass itself. now() is the transaction timestamp, so this
  --    matches exactly the set counted in step 1.
  update public.introduction_selections s
  set decision = 'released'
  where s.decision = 'explicit_pass'
    and s.decided_at < now() - make_interval(days => cooldown_days);

  get diagnostics expired = row_count;
  return expired;
end;
$$;

comment on function halal_mode_private.expire_explicit_passes() is
  'Downgrades explicit passes older than the configured cooldown so the pair may be considered again, and retires pairs passed often enough to count as settled. Idempotent; safe to run every cycle.';

-- ---------------------------------------------------------------------------
-- Hiding someone
--
-- Deliberately not a block. A block says somebody behaved badly and belongs
-- with reports and moderation; hiding your cousin says nothing about them at
-- all. Keeping them separate means a blocked list stays meaningful, and means
-- hiding never reads as an accusation to anyone who later reviews it.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.member_hides (
  hider_id   uuid not null references public.profiles(id) on delete cascade,
  hidden_id  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (hider_id, hidden_id),
  check (hider_id <> hidden_id)
);

create index if not exists member_hides_hidden_idx
  on halal_mode_private.member_hides (hidden_id);

comment on table halal_mode_private.member_hides is
  'Mutual, permanent, silent. Hiding someone removes them from your introductions and you from theirs. Neither member is ever told, and it carries no moderation meaning.';

revoke all on table halal_mode_private.member_hides from public, anon, authenticated;

create or replace function halal_mode_private.pair_is_hidden(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select exists (
    select 1 from halal_mode_private.member_hides
    where (hider_id = p_a and hidden_id = p_b)
       or (hider_id = p_b and hidden_id = p_a)
  );
$$;

create or replace function public.hide_member(p_subject_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_member uuid := auth.uid();
begin
  if v_member is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_subject_id = v_member then
    raise exception 'You cannot hide yourself' using errcode = '22023';
  end if;

  -- Only someone already introduced or connected can be hidden, so this cannot
  -- be used to probe whether an arbitrary account exists.
  if not exists (
    select 1 from public.introductions i
    where i.viewer_id = v_member and i.subject_id = p_subject_id
  ) and not exists (
    select 1 from public.connections c
    where c.user_a = least(v_member, p_subject_id)
      and c.user_b = greatest(v_member, p_subject_id)
  ) then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;

  insert into halal_mode_private.member_hides (hider_id, hidden_id)
  values (v_member, p_subject_id)
  on conflict (hider_id, hidden_id) do nothing;

  -- Retire the pair outright as well. A hidden pair should never be reconsidered
  -- by the repeat logic, whatever its score does later.
  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, retired_at, retired_reason
  )
  values (
    least(v_member, p_subject_id), greatest(v_member, p_subject_id),
    now(), 'hidden'
  )
  on conflict (user_low, user_high) do update
    set retired_at = coalesce(pe.retired_at, now()),
        retired_reason = coalesce(pe.retired_reason, 'hidden');
end;
$$;

comment on function public.hide_member(uuid) is
  'Hides a member in both directions, permanently and silently. For recognising someone in real life; carries no moderation meaning, unlike block_member.';

revoke all on function halal_mode_private.expire_explicit_passes() from public, anon, authenticated;
revoke all on function halal_mode_private.pair_is_hidden(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hide_member(uuid) from public, anon;
grant execute on function halal_mode_private.expire_explicit_passes() to service_role;
grant execute on function public.hide_member(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enforcement
--
-- passes_criteria() is restated below purely to add the hide check beside the
-- block check. It is the one gate every path shares — candidate generation
-- (0052), plan validation (0056) and finalisation (0052) all call it — so a
-- single check covers all three and cannot drift out of step with itself.
--
-- The body is otherwise identical to 0061, spliced mechanically rather than
-- retyped.
-- ---------------------------------------------------------------------------

create or replace function passes_criteria(p_viewer uuid, p_subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v private_preferences%rowtype;
  s profiles%rowtype;
  vp profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
begin
  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;

  if v is null or s is null or vp is null then return false; end if;

  -- Universal. Not preferences, and not negotiable.
  if s.gender = vp.gender or s.is_paused or not s.onboarding_complete then
    return false;
  end if;
  if exists (
    select 1 from blocks
    where (blocker_id = p_viewer and blocked_id = p_subject)
       or (blocker_id = p_subject and blocked_id = p_viewer)
  ) then
    return false;
  end if;

  -- Hiding is separate from blocking and just as absolute. Checked here because
  -- this function is the one gate every path shares — candidate generation, plan
  -- validation and finalisation all call it, so one check covers all three and
  -- cannot drift out of step with itself.
  if halal_mode_private.pair_is_hidden(p_viewer, p_subject) then
    return false;
  end if;

  -- Country remains reciprocal and explicit: crossing a border is a choice both
  -- members must have made, not a preference one can override.
  if not halal_mode_private.accepts_subject_country(p_viewer, p_subject) then
    return false;
  end if;

  -- Everything below applies only where the member marked it "Must have".
  -- Anything not marked is scored by compatibility() instead of excluded here,
  -- which is what lets a near-neighbour be a real candidate.

  s_age := extract(year from age(s.birth_date));
  if halal_mode_private.is_must_have(v.must_have, 'age')
     and (s_age < v.min_age or s_age > v.max_age) then
    return false;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'height')
     and s_prefs.own_height_cm is not null
     and (s_prefs.own_height_cm < v.min_height_cm or s_prefs.own_height_cm > v.max_height_cm) then
    return false;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'build')
     and array_length(v.preferred_builds, 1) is not null
     and s_prefs.own_build is not null
     and not (s_prefs.own_build = any (v.preferred_builds)) then
    return false;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'practice')
     and array_length(v.preferred_practice, 1) is not null
     and not (s.religious_practice = any (v.preferred_practice)) then
    return false;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'timeline')
     and array_length(v.desired_timeline, 1) is not null
     and not (s.timeline = any (v.desired_timeline)) then
    return false;
  end if;

  -- Declining to state a sect is never treated as a mismatch, even when the
  -- viewer has made sect absolute. Silence is not a difference.
  if halal_mode_private.is_must_have(v.must_have, 'sect')
     and array_length(v.preferred_sects, 1) is not null
     and s.sect <> 'prefer_not_to_say'
     and not (s.sect = any (v.preferred_sects)) then
    return false;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'children')
     and v.desired_family_goals is not null
     and array_length(v.desired_family_goals, 1) is not null
     and not (s.family_goals = any (v.desired_family_goals)) then
    return false;
  end if;

  -- Distance stays a hard limit for same-country pairs whether or not it is
  -- marked, because it fails closed on incomplete coordinates and a member who
  -- set a radius has already expressed a boundary. Cross-border pairs are
  -- governed by the reciprocal country check above.
  if lower(trim(vp.country)) = lower(trim(s.country)) then
    if vp.latitude is null or vp.longitude is null
       or s.latitude is null or s.longitude is null then
      return false;
    end if;
    if halal_mode_private.is_must_have(v.must_have, 'distance')
       and distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude) > v.max_distance_km then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function passes_criteria(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Configuration
--
-- Both new knobs are versioned rather than hardcoded, because "how long is a
-- pass" is exactly the kind of decision that should be auditable and
-- reversible without a deploy. Restated whole, not as a diff on version 2 —
-- 0068 exists because a chain of diffs broke silently and left the table
-- empty for four versions.
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
    'explicit_pass_cooldown_days', 'explicit_pass_retire_after',
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
    and (p ->> 'explicit_pass_retire_after')::numeric >= 2
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
  "explicit_pass_retire_after": 2,
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
  'Adds the explicit-pass cooldown and the pass count that settles a pair.',
  now();
