-- Time each check inside validation separately.
--
-- Validation as a whole was measured at 16ms for 16 edges and the insert at
-- about a second, yet a 74-edge batch runs past ninety. Something in there is
-- super-linear and none of the guesses so far have been right, so this stops
-- guessing: every check the veto query performs, timed on its own, against the
-- real edges.
--
-- Read-only. Writes nothing, takes no locks, so it cannot wedge anything.

create or replace function public.time_validation_parts_service(p_edges jsonb, p_take integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_slice jsonb;
  v_t timestamptz;
  v_consent numeric;
  v_blocks numeric;
  v_passes numeric;
  v_connections numeric;
  v_capacity numeric;
  v_exposure numeric;
  v_dummy boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_slice
  from (select e from jsonb_array_elements(p_edges) e limit greatest(1, p_take)) s;

  -- Legal consent, per member of every edge. A function call inside a row
  -- filter is the classic way a cheap-looking check becomes the whole cost.
  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1 from public.profiles p
      where p.id in (e.a, e.b)
        and (p.is_paused or not halal_mode_private.member_has_current_legal_consents(p.id))
    )
  ) into v_dummy;
  v_consent := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1 from public.blocks bl
      where (bl.blocker_id = e.a and bl.blocked_id = e.b)
         or (bl.blocker_id = e.b and bl.blocked_id = e.a)
    )
  ) into v_dummy;
  v_blocks := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1 from public.introduction_selections s
      where s.decision = 'explicit_pass'
        and ((s.viewer_id = e.a and s.subject_id = e.b)
          or (s.viewer_id = e.b and s.subject_id = e.a))
    )
  ) into v_dummy;
  v_passes := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1 from public.connections c
      where c.user_a = least(e.a, e.b) and c.user_b = greatest(e.a, e.b)
    )
  ) into v_dummy;
  v_connections := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1
      from (values (e.a), (e.b)) member(user_id)
      join public.profiles cp on cp.id = member.user_id
      cross join lateral public.tier_limits(cp.tier) limits
      where (
        select count(*) from public.connections ac
        where ac.closed_at is null
          and (ac.user_a = member.user_id or ac.user_b = member.user_id)
      ) >= limits.open_connections
    )
  ) into v_dummy;
  v_capacity := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(v_slice) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (
      select 1 from halal_mode_private.pair_exposure pe
      where pe.user_low = least(e.a, e.b) and pe.user_high = greatest(e.a, e.b)
        and (pe.retired_at is not null or pe.times_shown >= 5
          or (pe.cooldown_until is not null and pe.cooldown_until > now()))
    )
  ) into v_dummy;
  v_exposure := round(extract(epoch from (clock_timestamp() - v_t)) * 1000);

  return jsonb_build_object(
    'edges', jsonb_array_length(v_slice),
    'consent_ms', v_consent,
    'blocks_ms', v_blocks,
    'passes_ms', v_passes,
    'connections_ms', v_connections,
    'capacity_ms', v_capacity,
    'exposure_ms', v_exposure
  );
end;
$$;

revoke all on function public.time_validation_parts_service(jsonb, integer) from public, anon, authenticated;
grant execute on function public.time_validation_parts_service(jsonb, integer) to service_role;
