-- The same instrumentation, now including the seven safety vetoes.
--
-- The vetoes measured 1-5ms each in a standalone probe and validation still
-- takes 115 seconds with nothing else left in it. Either they behave
-- differently in this context — after the locks are held, in the same
-- transaction — or one of them is not what it appears. Timed here in exactly
-- that context, one clock per check.

create or replace function public.time_validate_steps2_service(p_run_id uuid, p_edges jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_config jsonb;
  v_min_score numeric;
  v_boost_cap numeric;
  v_max_appearances integer;
  v_user uuid;
  v_pair record;
  v_t timestamptz;
  v_out jsonb := '{}'::jsonb;
  v_dummy boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Timing requires service role' using errcode = '42501';
  end if;

  v_t := clock_timestamp();
  select * into v_run from halal_mode_private.matching_runs where id = p_run_id;
  select params into v_config from halal_mode_private.matching_config where version = v_run.config_version;
  v_min_score := (v_config ->> 'min_reciprocal_score')::numeric;
  v_boost_cap := (v_config ->> 'boost_cap')::numeric;
  v_max_appearances := (v_config ->> 'max_pair_appearances')::integer;
  v_out := v_out || jsonb_build_object('setup_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  perform pg_try_advisory_xact_lock(hashtextextended('matching-legal-consent-epoch', 5810));
  for v_user in
    select distinct member_id
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    cross join lateral (values (e.a), (e.b)) member(member_id)
    order by member_id
  loop
    perform pg_try_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;
  for v_pair in
    select distinct least(e.a, e.b) as user_low, greatest(e.a, e.b) as user_high
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    order by user_low, user_high
  loop
    perform pg_try_advisory_xact_lock(hashtextextended(
      v_pair.user_low::text || ':' || v_pair.user_high::text, 5811));
  end loop;
  v_out := v_out || jsonb_build_object('locks_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where e.a = e.b or e.score < v_min_score or e.score > 1
       or e.utility < 0 or e.utility > round(e.score * (1 + v_boost_cap), 5)
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('bounds_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    left join halal_mode_private.matching_run_candidate_snapshots c
      on c.run_id = p_run_id and c.user_low = least(e.a, e.b) and c.user_high = greatest(e.a, e.b)
    where c.run_id is null
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('frozen_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    group by least(e.a, e.b), greatest(e.a, e.b) having count(*) > 1
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('duplicates_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  -- The capacity check as written in validation, with its left join and the
  -- lateral tier_limits call. Never measured on its own until now.
  v_t := clock_timestamp();
  select exists (
    with parsed as (
      select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b from jsonb_array_elements(p_edges) e
    ), counts as (
      select member.user_id, count(*)::integer edge_count
      from parsed p cross join lateral (values (p.a), (p.b)) member(user_id)
      group by member.user_id
    )
    select 1 from counts c
    left join public.profiles profile on profile.id = c.user_id
    cross join lateral public.tier_limits(profile.tier) limits
    where c.edge_count > limits.introductions
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('capacity_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));


  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where not exists (select 1 from public.profiles p where p.id = e.a)
       or not exists (select 1 from public.profiles p where p.id = e.b)
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('missing_profiles_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from public.blocks bl where (bl.blocker_id = e.a and bl.blocked_id = e.b) or (bl.blocker_id = e.b and bl.blocked_id = e.a))
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('blocks_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from public.introduction_selections s where s.decision = 'explicit_pass' and ((s.viewer_id = e.a and s.subject_id = e.b) or (s.viewer_id = e.b and s.subject_id = e.a)))
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('passes_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from public.connections c where c.user_a = least(e.a, e.b) and c.user_b = greatest(e.a, e.b))
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('connections_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from public.profiles p where p.id in (e.a, e.b) and (p.is_paused or not halal_mode_private.member_has_current_legal_consents(p.id)))
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('consent_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from (values (e.a), (e.b)) member(user_id) join public.profiles cp on cp.id = member.user_id cross join lateral public.tier_limits(cp.tier) limits where (select count(*) from public.connections ac where ac.closed_at is null and (ac.user_a = member.user_id or ac.user_b = member.user_id)) >= limits.open_connections)
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('capacity2_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  v_t := clock_timestamp();
  select exists (
    select 1 from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    where exists (select 1 from halal_mode_private.pair_exposure pe where pe.user_low = least(e.a, e.b) and pe.user_high = greatest(e.a, e.b) and (pe.retired_at is not null or pe.times_shown >= v_max_appearances or (pe.cooldown_until is not null and pe.cooldown_until > now())))
  ) into v_dummy;
  v_out := v_out || jsonb_build_object('exposure_ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000));

  return v_out;
end;
$$;

revoke all on function public.time_validate_steps2_service(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.time_validate_steps2_service(uuid, jsonb) to service_role;
