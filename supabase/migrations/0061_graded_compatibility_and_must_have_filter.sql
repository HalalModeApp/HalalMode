-- Graded compatibility, and must-have as the only hard filter.
--
-- Two problems are fixed together, because they are the same problem.
--
-- 1. Practice and timeline were hard-filtered in passes_criteria() and *then*
--    scored in compatibility(). Every pair that reached scoring had already
--    passed, so both terms were permanently 1.0. The two criteria members care
--    about most contributed nothing to ranking, and the score was effectively
--    age + height + distance + languages — the four least important things.
--
-- 2. compatibility() averaged its terms equally, so shared languages counted as
--    much as religious practice.
--
-- Now: nothing is filtered unless the member marked it "Must have", everything
-- grades by distance along an ordered scale, and the terms are weighted.
--
-- Weights and falloffs live in matching_config so the tuner can move them
-- toward mutual-first-choice outcomes without a migration.

-- ---------------------------------------------------------------------------
-- Configuration version 3
-- ---------------------------------------------------------------------------

insert into halal_mode_private.matching_config (version, params, notes, activated_at)
select
  3,
  params || jsonb_build_object(
    -- Roughly 45/55 between values-and-intent and attraction-and-practicality.
    -- The app's stated position is that ignoring attraction produces
    -- introductions people will not consider, so build, height, age and
    -- distance are weighted accordingly rather than treated as afterthoughts.
    'weights', jsonb_build_object(
      'practice',   0.20,
      'age',        0.15,
      'children',   0.14,
      'timeline',   0.11,
      'build',      0.11,
      'distance',   0.10,
      'height',     0.09,
      'relocation', 0.08,
      'languages',  0.02
    ),
    -- Score at one step along each scale. Practice is the reviewed 0.70:
    -- a practicing candidate is a real option for someone seeking very
    -- practicing, and two steps away mostly is not.
    'falloff', jsonb_build_object(
      'practice',   0.70,
      'timeline',   0.85,
      'relocation', 0.80,
      'children',   0.65,
      'build',      0.88
    ),
    -- Everything inside this radius is "same city" and scores full marks;
    -- distance only starts to count beyond it.
    'distance_free_km', 25,
    -- Sect is graded, not binary, and 'prefer_not_to_say' never counts against
    -- anyone. A stated difference scores this rather than zero.
    'sect_mismatch_score', 0.15
  ),
  'Graded weighted compatibility; must-have becomes the only hard filter.',
  now()
from halal_mode_private.matching_config
where version = 2;

-- ---------------------------------------------------------------------------
-- Eligibility
--
-- Only three things are absolute for everyone: opposite gender, no block in
-- either direction, and a countable location when a member has capped their
-- distance. Everything else is absolute only for the member who said so.
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

-- ---------------------------------------------------------------------------
-- Weighted, graded compatibility
--
-- Directional: how well the subject suits the viewer's stated preferences.
-- Still the cold-start signal, so a member with no behavioural history is
-- scored entirely on stated fit rather than penalised for being new.
--
-- Still not a desirability score. It is about one person's fit with one other
-- person, and no client role can reach it.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.compatibility(
  p_viewer uuid,
  p_subject uuid
) returns numeric
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb;
  w jsonb;
  f jsonb;
  v private_preferences%rowtype;
  vp profiles%rowtype;
  s profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
  total numeric := 0;
  used numeric := 0;
  term numeric;
  best numeric;
  distance numeric;
  free_km numeric;

  -- Adds one scored term with its weight. Terms whose inputs are missing are
  -- skipped entirely rather than scored zero, so an incomplete profile is not
  -- punished for the fields it has not filled in.
  procedure_note text;
begin
  cfg := halal_mode_private.active_matching_config();
  w := coalesce(cfg -> 'weights', '{}'::jsonb);
  f := coalesce(cfg -> 'falloff', '{}'::jsonb);
  free_km := coalesce((cfg ->> 'distance_free_km')::numeric, 25);

  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;
  if v is null or vp is null or s is null then return 0; end if;

  -- Age: full marks inside the stated range, tapering outside it by the same
  -- width again. The member's own min and max already encode whatever
  -- asymmetry they hold, so no extra adjustment is applied on top.
  s_age := extract(year from age(s.birth_date));
  if s_age between v.min_age and v.max_age then
    term := 1.0;
  else
    term := greatest(0, 1 - (
      case when s_age < v.min_age then v.min_age - s_age else s_age - v.max_age end
    )::numeric / greatest(1, v.max_age - v.min_age));
  end if;
  total := total + term * coalesce((w ->> 'age')::numeric, 0);
  used := used + coalesce((w ->> 'age')::numeric, 0);

  -- Height, on the same shape.
  if s_prefs.own_height_cm is not null then
    if s_prefs.own_height_cm between v.min_height_cm and v.max_height_cm then
      term := 1.0;
    else
      term := greatest(0, 1 - (
        case when s_prefs.own_height_cm < v.min_height_cm
          then v.min_height_cm - s_prefs.own_height_cm
          else s_prefs.own_height_cm - v.max_height_cm end
      )::numeric / greatest(1, v.max_height_cm - v.min_height_cm));
    end if;
    total := total + term * coalesce((w ->> 'height')::numeric, 0);
    used := used + coalesce((w ->> 'height')::numeric, 0);
  end if;

  -- Build: best proximity across the selected builds, so choosing three does
  -- not exclude the near-identical fourth.
  if array_length(v.preferred_builds, 1) is not null and s_prefs.own_build is not null then
    select max(halal_mode_private.scale_proximity(
             'build', wanted.value, s_prefs.own_build,
             coalesce((f ->> 'build')::numeric, 0.88)))
    into best
    from unnest(v.preferred_builds) wanted(value);
    total := total + coalesce(best, 1.0) * coalesce((w ->> 'build')::numeric, 0);
    used := used + coalesce((w ->> 'build')::numeric, 0);
  end if;

  -- Practice, timeline, children: nearest acceptable value on each scale.
  if array_length(v.preferred_practice, 1) is not null then
    select max(halal_mode_private.scale_proximity(
             'practice', wanted.value::text, s.religious_practice::text,
             coalesce((f ->> 'practice')::numeric, 0.70)))
    into best
    from unnest(v.preferred_practice) wanted(value);
    total := total + coalesce(best, 1.0) * coalesce((w ->> 'practice')::numeric, 0);
    used := used + coalesce((w ->> 'practice')::numeric, 0);
  end if;

  if array_length(v.desired_timeline, 1) is not null then
    select max(halal_mode_private.scale_proximity(
             'timeline', wanted.value::text, s.timeline::text,
             coalesce((f ->> 'timeline')::numeric, 0.85)))
    into best
    from unnest(v.desired_timeline) wanted(value);
    total := total + coalesce(best, 1.0) * coalesce((w ->> 'timeline')::numeric, 0);
    used := used + coalesce((w ->> 'timeline')::numeric, 0);
  end if;

  if v.desired_family_goals is not null and array_length(v.desired_family_goals, 1) is not null then
    select max(halal_mode_private.scale_proximity(
             'children', wanted.value::text, s.family_goals::text,
             coalesce((f ->> 'children')::numeric, 0.65)))
    into best
    from unnest(v.desired_family_goals) wanted(value);
    total := total + coalesce(best, 1.0) * coalesce((w ->> 'children')::numeric, 0);
    used := used + coalesce((w ->> 'children')::numeric, 0);
  end if;

  -- Relocation, compared between the two members rather than against a stated
  -- preference: it is about whether their intentions can meet.
  term := halal_mode_private.scale_proximity(
    'relocation', vp.relocation::text, s.relocation::text,
    coalesce((f ->> 'relocation')::numeric, 0.80));
  total := total + term * coalesce((w ->> 'relocation')::numeric, 0);
  used := used + coalesce((w ->> 'relocation')::numeric, 0);

  -- Sect. Declining to state is compatible with everything.
  if array_length(v.preferred_sects, 1) is not null then
    if s.sect = 'prefer_not_to_say' or s.sect = any (v.preferred_sects) then
      term := 1.0;
    else
      term := coalesce((cfg ->> 'sect_mismatch_score')::numeric, 0.15);
    end if;
    total := total + term * coalesce((w ->> 'practice')::numeric, 0) * 0.5;
    used := used + coalesce((w ->> 'practice')::numeric, 0) * 0.5;
  end if;

  -- Distance: flat inside the free radius, then falling toward the member's cap.
  if lower(trim(vp.country)) = lower(trim(s.country))
     and vp.latitude is not null and s.latitude is not null then
    distance := distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude);
    if distance <= free_km then
      term := 1.0;
    else
      term := greatest(0, 1 - (distance - free_km) / greatest(1, v.max_distance_km - free_km));
    end if;
  else
    -- Crossing a border was already an explicit reciprocal choice by both
    -- members, so it is neither rewarded nor penalised here.
    term := 0.75;
  end if;
  total := total + term * coalesce((w ->> 'distance')::numeric, 0);
  used := used + coalesce((w ->> 'distance')::numeric, 0);

  -- Languages, deliberately the smallest weight.
  term := least(1.0, (
    select count(*)::numeric / 2
    from unnest(coalesce(vp.languages_spoken, '{}')) l(lang)
    where lang = any (coalesce(s.languages_spoken, '{}'))
  ));
  total := total + term * coalesce((w ->> 'languages')::numeric, 0);
  used := used + coalesce((w ->> 'languages')::numeric, 0);

  if used <= 0 then return 0.5; end if;
  -- Renormalised over the terms that applied, so a member with fewer stated
  -- preferences is not scored lower than one who filled in everything.
  return round(least(1.0, greatest(0.0, total / used)), 5);
end;
$$;

revoke all on function passes_criteria(uuid, uuid) from public, anon, authenticated;
revoke all on function halal_mode_private.compatibility(uuid, uuid) from public, anon, authenticated;
