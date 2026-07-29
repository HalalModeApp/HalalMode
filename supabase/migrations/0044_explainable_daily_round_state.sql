-- Explain an empty daily set using only the signed-in member's own readiness
-- and matching inputs. The status never reports candidate counts, another
-- member's data, or which private preference prevented an introduction.

create or replace function public.get_current_round_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_member_id uuid := auth.uid();
  v_profile profiles%rowtype;
  v_preferences private_preferences%rowtype;
  v_round jsonb;
begin
  if v_member_id is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  if not profile_is_ready_for_matching(v_member_id) then
    return jsonb_build_object('status', 'profile_not_ready', 'round', null);
  end if;

  -- Preserve an already-generated, non-empty round before considering whether
  -- the member's inputs can be used for a future matching run.
  v_round := get_current_round();
  if v_round is not null
     and jsonb_array_length(coalesce(v_round->'introductions', '[]'::jsonb)) > 0 then
    return jsonb_build_object('status', 'ready', 'round', v_round);
  end if;

  select * into v_profile from profiles where id = v_member_id;
  select * into v_preferences from private_preferences where user_id = v_member_id;

  if v_profile.latitude is null
     or v_profile.longitude is null
     or v_profile.latitude not between -90 and 90
     or v_profile.longitude not between -180 and 180
     or v_preferences is null
     or v_preferences.matching_preferences_completed_at is null then
    return jsonb_build_object(
      'status', 'matching_inputs_unavailable',
      'round', v_round
    );
  end if;

  return jsonb_build_object(
    'status', 'no_suitable_introductions',
    'round', v_round
  );
end;
$$;

revoke all on function public.get_current_round_state() from public, anon;
grant execute on function public.get_current_round_state() to authenticated;
