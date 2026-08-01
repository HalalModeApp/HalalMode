-- Tell a deferred member the truth.
--
-- When rotation defers someone because the pool is imbalanced, the existing
-- empty state said "No suitable introductions today — we could not prepare a
-- reciprocal introduction that fits both people's choices." That is wrong and
-- discouraging in the way that matters most: nobody was found unsuitable, and
-- nothing about their profile or preferences is the problem. They are in a
-- queue, ordered by who has waited longest, and their turn is coming.
--
-- `awaiting_turn` is therefore a distinct state, not a variant of the existing
-- copy. It carries no blame and no instruction to change anything.

create or replace function public.get_daily_round_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v_user uuid := auth.uid();
  v_round rounds%rowtype;
  v_intro_count int;
  v_paused boolean;
  v_waiting boolean;
begin
  if v_user is null then
    return jsonb_build_object('status', 'matching_inputs_unavailable');
  end if;
  if not public.profile_is_ready_for_matching(v_user) then
    return jsonb_build_object('status', 'profile_not_ready');
  end if;

  select is_paused into v_paused from profiles where id = v_user;
  if coalesce(v_paused, false) then
    return jsonb_build_object('status', 'paused');
  end if;

  select * into v_round
  from rounds
  where user_id = v_user and submitted_at is null and expires_at > now()
  order by opens_at desc
  limit 1;

  if v_round.id is not null then
    select count(*)::int into v_intro_count
    from introductions where round_id = v_round.id and viewer_id = v_user;
    if v_intro_count > 0 then
      return jsonb_build_object('status', 'ready', 'round', v_round.id);
    end if;
  end if;

  -- At the active match cap, rounds pause by design and resume underneath it.
  -- That is a full inbox, not a failure to find anyone.
  select h.active_match_count >= l.open_connections
  into v_waiting
  from halal_mode_private.match_health h
  join profiles p on p.id = h.user_id
  cross join lateral tier_limits(p.tier) l
  where h.user_id = v_user;

  if coalesce(v_waiting, false) then
    return jsonb_build_object('status', 'at_match_capacity');
  end if;

  -- Eligible, under capacity, but no round was prepared. Under rotation that
  -- means the pool is imbalanced and this member is queued rather than
  -- unmatched. Distinguishing the two is the whole point of this migration:
  -- one is about them, the other is only about arithmetic.
  if exists (select 1 from halal_mode_private.matching_pool where id = v_user) then
    return jsonb_build_object('status', 'awaiting_turn');
  end if;

  return jsonb_build_object('status', 'no_suitable_introductions');
end;
$$;

revoke all on function public.get_daily_round_state() from public, anon;
grant execute on function public.get_daily_round_state() to authenticated;
