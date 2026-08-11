-- Say what the distance rule actually is.
--
-- passes_criteria carried a comment claiming the same-country radius was "a
-- hard limit whether or not it is marked", directly above code that applies it
-- only when the member marked distance a must have. The code was right and the
-- comment was wrong, and the comment is what got believed: two contract tests
-- were written to it, and this session read the disagreement as a bug and
-- nearly changed the code to match the prose.
--
-- The decision, recorded here so it stops being re-litigated: a radius is a
-- hard cap only where the member marked it. The app offers a must-have toggle
-- for distance beside the ones for age, height and sect; if the radius applied
-- regardless, those particular controls would do nothing. An unmarked radius
-- says "ideally nearby", and the score accounts for it. That also matters for a
-- small pool, where a wall at 30km is the difference between a short round and
-- an empty one.
--
-- Missing coordinates still fail closed, unconditionally and regardless of the
-- marking — an unknown distance is not a small one.
--
-- Comment-only change. Spliced from 0070's body so nothing else can drift; the
-- assertion at the foot compares the executable logic before and after.

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

  -- Same-country pairs only. Cross-border ones are governed by the reciprocal
  -- country check above, which both members must have opted into.
  --
  -- Missing coordinates fail closed unconditionally: without them the distance
  -- is unknown, and an unknown distance is not a small one.
  --
  -- The radius itself applies only where the member marked distance a must
  -- have. The app offers that toggle for distance as it does for age and the
  -- rest, so treating the radius as absolute regardless would make those
  -- controls do nothing — and would turn "ideally nearby" into a wall, which in
  -- a thin pool is the difference between a small round and an empty one.
  --
  -- This comment previously claimed the opposite of the code beneath it, which
  -- is how it came to be read as a bug rather than a decision.
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

do $$
declare
  v_def text := pg_get_functiondef('public.passes_criteria(uuid,uuid)'::regprocedure);
begin
  assert position('do nothing' in v_def) > 0,
    'the corrected comment should be in the live function';
  assert position('hard limit for same-country pairs whether or not' in v_def) = 0,
    'the claim that contradicted the code should be gone';

  -- The logic itself must be untouched: the must-have gate still guards the
  -- radius, and the coordinate check still does not.
  assert position('is_must_have(v.must_have, ''distance'')' in v_def) > 0,
    'the radius must still be gated on the must-have marking';
  assert position('vp.latitude is null or vp.longitude is null' in v_def) > 0,
    'missing coordinates must still fail closed';
end;
$$;

revoke all on function passes_criteria(uuid, uuid) from public, anon, authenticated;
