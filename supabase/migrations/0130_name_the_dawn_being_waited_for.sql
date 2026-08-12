-- Say which dawn the member is waiting for.
--
-- The waiting state is exactly when naming the city helps most: there is no
-- round on screen to carry it, and "it opens at Fajr" is otherwise a time in
-- somebody else's city.

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
  v_next_opens_at timestamptz;
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

  -- A set that exists but has not opened yet. Every other answer below this
  -- point describes something being wrong — no candidates, filters too narrow,
  -- at capacity — and none of them is true of somebody who simply has not
  -- reached their own dawn.
  select min(opens_at) into v_next_opens_at
  from public.rounds
  where user_id = v_member_id and submitted_at is null
    and opens_at > now() and expires_at > now();
  if v_next_opens_at is not null then
    return jsonb_build_object(
      'status', 'next_set_scheduled',
      'round', null,
      'nextOpensAt', v_next_opens_at,
      -- Named so the app can say whose dawn it is waiting for, which is the
      -- one moment that matters most: there is no round on screen to carry it.
      'city', (select city from public.profiles where id = v_member_id)
    );
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
