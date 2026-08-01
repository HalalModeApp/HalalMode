-- Truthful daily-round states for rotation and connection capacity.
--
-- Extend the existing reviewed RPC rather than creating a parallel contract.
-- The ready branch continues to return the complete privacy-safe round object;
-- only coarse empty-state reasons are added. Deferred is read from a durable
-- live-run outcome, never inferred from pool membership. Shadow runs cannot
-- create that outcome.

drop function if exists public.get_daily_round_state();

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

  -- Preserve the reviewed response shape. A ready response always contains
  -- the complete safe round object, never a bare id.
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

  -- no_candidate, a stale outcome, a shadow-only proposal, and inconsistent
  -- served-without-round state all fail closed to the established message.
  return jsonb_build_object('status', 'no_suitable_introductions', 'round', null);
end;
$$;

revoke all on function public.get_current_round_state() from public, anon;
grant execute on function public.get_current_round_state() to authenticated;
