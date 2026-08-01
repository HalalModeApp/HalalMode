-- Tell a member when their own filters are the reason.
--
-- 0053 stopped the app blaming someone for a deferred turn. This closes the
-- other misattribution: a member who marked several criteria "Must have" and
-- received nothing was shown "No suitable introductions today", which reads as
-- a statement about them and about the pool. It is neither. It is arithmetic
-- they can undo in one tap, and they cannot act on it unless we say so.
--
-- Must-haves are also the one thing learning can never correct. The matcher
-- improves by observing outcomes and it never observes a pair a hard filter
-- excluded, so an over-tight filter stays invisible to the model forever. That
-- makes this message the only feedback loop those members have.

/**
 * Which single must-have is costing this member the most.
 *
 * Counts how many of the opposite side they would still be eligible for if each
 * must-have were relaxed on its own, and names the one that opens up the most.
 *
 * Deliberately approximate. It ignores the *other* member's must-haves, so the
 * true gain is smaller than the count suggests — but the ordering is what
 * matters, and the ordering is right. It also runs only for members who
 * received nothing, so it is never on the common path.
 *
 * At a few hundred members this is a handful of counting queries. It will need
 * revisiting well before the pool reaches tens of thousands.
 */
create or replace function halal_mode_private.most_restrictive_must_have(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v private_preferences%rowtype;
  vp profiles%rowtype;
  best_criterion text := null;
  best_gain int := 0;
  gain int;
begin
  select * into v from private_preferences where user_id = p_user_id;
  select * into vp from profiles where id = p_user_id;
  if v is null or vp is null then return null; end if;

  if halal_mode_private.is_must_have(v.must_have, 'age') then
    select count(*) into gain from halal_mode_private.matching_pool pool
    where pool.gender <> vp.gender
      and (pool.age < v.min_age or pool.age > v.max_age);
    if gain > best_gain then best_gain := gain; best_criterion := 'age'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'height') then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join private_preferences pp on pp.user_id = pool.id
    where pool.gender <> vp.gender
      and pp.own_height_cm is not null
      and (pp.own_height_cm < v.min_height_cm or pp.own_height_cm > v.max_height_cm);
    if gain > best_gain then best_gain := gain; best_criterion := 'height'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'build')
     and array_length(v.preferred_builds, 1) is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join private_preferences pp on pp.user_id = pool.id
    where pool.gender <> vp.gender
      and pp.own_build is not null
      and not (pp.own_build = any (v.preferred_builds));
    if gain > best_gain then best_gain := gain; best_criterion := 'build'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'practice')
     and array_length(v.preferred_practice, 1) is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join profiles p on p.id = pool.id
    where pool.gender <> vp.gender
      and not (p.religious_practice = any (v.preferred_practice));
    if gain > best_gain then best_gain := gain; best_criterion := 'practice'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'timeline')
     and array_length(v.desired_timeline, 1) is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join profiles p on p.id = pool.id
    where pool.gender <> vp.gender
      and not (p.timeline = any (v.desired_timeline));
    if gain > best_gain then best_gain := gain; best_criterion := 'timeline'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'children')
     and array_length(v.desired_family_goals, 1) is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join profiles p on p.id = pool.id
    where pool.gender <> vp.gender
      and not (p.family_goals = any (v.desired_family_goals));
    if gain > best_gain then best_gain := gain; best_criterion := 'children'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'sect')
     and array_length(v.preferred_sects, 1) is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    join profiles p on p.id = pool.id
    where pool.gender <> vp.gender
      -- Unstated is never excluded, so it is never part of the cost either.
      and p.sect <> 'prefer_not_to_say'
      and not (p.sect = any (v.preferred_sects));
    if gain > best_gain then best_gain := gain; best_criterion := 'sect'; end if;
  end if;

  if halal_mode_private.is_must_have(v.must_have, 'distance')
     and vp.latitude is not null and vp.longitude is not null then
    select count(*) into gain
    from halal_mode_private.matching_pool pool
    where pool.gender <> vp.gender
      and pool.latitude is not null and pool.longitude is not null
      and lower(trim(pool.country)) = lower(trim(vp.country))
      and distance_km(vp.latitude, vp.longitude, pool.latitude, pool.longitude) > v.max_distance_km;
    if gain > best_gain then best_gain := gain; best_criterion := 'distance'; end if;
  end if;

  return best_criterion;
end;
$$;

revoke all on function halal_mode_private.most_restrictive_must_have(uuid)
  from public, anon, authenticated;

/**
 * Adds `filters_too_narrow` ahead of the established fallback.
 *
 * Ordering matters: a member deferred by rotation is told that first, because
 * their filters are not the cause and asking them to loosen something would be
 * both wrong and discouraging. Only a member who was genuinely offered nothing
 * *and* holds a must-have sees this.
 */
create or replace function public.get_current_round_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v_member_id uuid := auth.uid();
  v_profile profiles%rowtype;
  v_preferences private_preferences%rowtype;
  v_round jsonb;
  v_at_capacity boolean := false;
  v_outcome text;
  v_criterion text;
begin
  if v_member_id is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if not halal_mode_private.member_has_current_legal_consents(v_member_id) then
    return jsonb_build_object('status', 'legal_consent_required', 'round', null);
  end if;
  if not public.profile_is_ready_for_matching(v_member_id) then
    return jsonb_build_object('status', 'profile_not_ready', 'round', null);
  end if;

  v_round := public.get_current_round();
  if v_round is not null
     and jsonb_array_length(coalesce(v_round -> 'introductions', '[]'::jsonb)) > 0 then
    return jsonb_build_object('status', 'ready', 'round', v_round);
  end if;

  select * into v_profile from public.profiles where id = v_member_id;
  select * into v_preferences from public.private_preferences where user_id = v_member_id;
  if v_profile.latitude is null or v_profile.longitude is null
     or v_profile.latitude not between -90 and 90
     or v_profile.longitude not between -180 and 180
     or v_preferences is null
     or v_preferences.matching_preferences_completed_at is null then
    return jsonb_build_object(
      'status', 'matching_inputs_unavailable', 'round', coalesce(v_round, 'null'::jsonb)
    );
  end if;

  select h.active_match_count >= limits.open_connections
  into v_at_capacity
  from halal_mode_private.match_health h
  join public.profiles p on p.id = h.user_id
  cross join lateral public.tier_limits(p.tier) limits
  where h.user_id = v_member_id;
  if coalesce(v_at_capacity, false) then
    return jsonb_build_object('status', 'at_match_capacity', 'round', null);
  end if;

  select o.outcome into v_outcome
  from halal_mode_private.matching_member_run_outcomes o
  join halal_mode_private.matching_runs r on r.id = o.run_id
  where o.user_id = v_member_id
    and o.valid_until > now()
    and r.mode = 'live'
    and r.error is null
  order by r.started_at desc
  limit 1;

  if v_outcome = 'deferred' then
    return jsonb_build_object('status', 'awaiting_turn', 'round', null);
  end if;

  -- Their own filters, and which one to loosen first.
  v_criterion := halal_mode_private.most_restrictive_must_have(v_member_id);
  if v_criterion is not null then
    return jsonb_build_object(
      'status', 'filters_too_narrow',
      'criterion', v_criterion,
      'round', null
    );
  end if;

  -- A stale outcome, a shadow-only proposal, and inconsistent served-without-
  -- round state all fail closed to the established message.
  return jsonb_build_object('status', 'no_suitable_introductions', 'round', null);
end;
$$;

revoke all on function public.get_current_round_state() from public, anon;
grant execute on function public.get_current_round_state() to authenticated;
