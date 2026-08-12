-- The budget has to cover taking all the locks, not each one.
--
-- 0114 bounded each lock acquisition at ten seconds, which reads as a fix and
-- is not one. Validation takes the consent epoch, then one lock per member,
-- then one per pair — for a 97-pair round that is nearly two hundred locks, so
-- the real worst case was over half an hour, and a direct call duly ran past
-- two minutes and was cut off by the gateway.
--
-- The deadline is now computed once and shared by every lock in the phase.
-- Fifteen seconds to acquire everything or the run fails cleanly and lets go
-- of its connection, whether that is one contended lock or two hundred.

drop function if exists halal_mode_private.take_matching_lock(text, bigint);

create or replace function halal_mode_private.take_matching_lock(
  p_key text,
  p_salt bigint,
  p_deadline timestamptz
) returns void
language plpgsql
set search_path = pg_catalog, public as $$
begin
  loop
    if pg_try_advisory_xact_lock(hashtextextended(p_key, p_salt)) then
      return;
    end if;
    if clock_timestamp() > p_deadline then
      raise exception 'MATCHING_LOCK_BUSY: gave up waiting for %', p_key
        using errcode = '55P03';
    end if;
    perform pg_sleep(0.05);
  end loop;
end;
$$;

revoke all on function halal_mode_private.take_matching_lock(text, bigint, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function halal_mode_private.validate_frozen_matching_edges(
  p_run_id uuid,
  p_edges jsonb,
  p_at timestamptz
) returns void
language plpgsql
volatile
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
  v_lock_deadline timestamptz;
begin
  -- One budget for taking every lock, not one budget each. A round of this
  -- size takes nearly two hundred locks; ten seconds apiece is half an hour.
  v_lock_deadline := clock_timestamp() + interval '15 seconds';
  select * into v_run from halal_mode_private.matching_runs where id = p_run_id;
  if v_run.id is null or v_run.candidate_snapshot_prepared_at is null
     or jsonb_typeof(p_edges) is distinct from 'array' or p_at is null then
    raise exception 'A prepared run and edge array are required'
      using errcode = '22023';
  end if;
  select params into v_config from halal_mode_private.matching_config
  where version = v_run.config_version;
  v_min_score := (v_config ->> 'min_reciprocal_score')::numeric;
  v_boost_cap := (v_config ->> 'boost_cap')::numeric;
  v_max_appearances := (v_config ->> 'max_pair_appearances')::integer;

  -- Lock the legal-consent epoch first, then every member and pair in stable
  -- order. Safety-table mutation triggers below use this same order, so a
  -- block, pass, consent withdrawal, connection, or exposure update cannot
  -- slip between validation and persistence.
  perform halal_mode_private.take_matching_lock('matching-legal-consent-epoch', 5810, v_lock_deadline);
  for v_user in
    select distinct member_id
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    cross join lateral (values (e.a), (e.b)) member(member_id)
    order by member_id
  loop
    perform halal_mode_private.take_matching_lock(v_user::text, 1919, v_lock_deadline);
  end loop;
  for v_pair in
    select distinct least(e.a, e.b) as user_low, greatest(e.a, e.b) as user_high
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    order by user_low, user_high
  loop
    perform halal_mode_private.take_matching_lock(
      v_pair.user_low::text || ':' || v_pair.user_high::text, 5811, v_lock_deadline
    );
  end loop;

  begin
    if exists (
      with parsed as materialized (
        select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b,
               (e ->> 'score')::numeric score,
               (e ->> 'utility')::numeric utility
        from jsonb_array_elements(p_edges) e
      )
      select 1 from parsed p
      where p.a = p.b or p.score < v_min_score or p.score > 1
         or p.utility < 0 or p.utility > round(p.score * (1 + v_boost_cap), 5)
         or not exists (
           select 1 from halal_mode_private.matching_run_candidate_snapshots c
           where c.run_id = p_run_id
             and c.user_low = least(p.a, p.b)
             and c.user_high = greatest(p.a, p.b)
         )
    ) then
      raise exception 'Every chosen edge must be a bounded frozen candidate'
        using errcode = '40001';
    end if;
    if exists (
      select 1
      from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
      group by least(e.a, e.b), greatest(e.a, e.b) having count(*) > 1
    ) then
      raise exception 'Frozen matching edges contain a duplicate pair'
        using errcode = '22023';
    end if;
    if exists (
      with parsed as (
        select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b
        from jsonb_array_elements(p_edges) e
      ), counts as (
        select member.user_id, count(*)::integer edge_count
        from parsed p cross join lateral (values (p.a), (p.b)) member(user_id)
        group by member.user_id
      )
      select 1 from counts c
      left join public.profiles profile on profile.id = c.user_id
      cross join lateral public.tier_limits(profile.tier) limits
      where c.edge_count > limits.introductions
    ) then
      raise exception 'A frozen matching plan exceeds member capacity'
        using errcode = '22023';
    end if;

    -- Late blocks, deliberate passes, any historical connection, pause, active
    -- connection capacity, or new exposure retirement/cooldown are safety
    -- vetoes. Ordinary compatibility/profile preference edits are not.
    if exists (
      select 1
      from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
      where not exists (
        select 1 from public.profiles p where p.id = e.a
      ) or not exists (
        select 1 from public.profiles p where p.id = e.b
      ) or exists (
        select 1 from public.blocks bl
        where (bl.blocker_id = e.a and bl.blocked_id = e.b)
           or (bl.blocker_id = e.b and bl.blocked_id = e.a)
      ) or exists (
        select 1 from public.introduction_selections s
        where s.decision = 'explicit_pass'
          and ((s.viewer_id = e.a and s.subject_id = e.b)
            or (s.viewer_id = e.b and s.subject_id = e.a))
      ) or exists (
        select 1 from public.connections c
        where c.user_a = least(e.a, e.b) and c.user_b = greatest(e.a, e.b)
      ) or exists (
        select 1 from public.profiles p
        where p.id in (e.a, e.b)
          and (p.is_paused or not halal_mode_private.member_has_current_legal_consents(p.id))
      ) or exists (
        select 1
        from (values (e.a), (e.b)) member(user_id)
        join public.profiles current_profile on current_profile.id = member.user_id
        cross join lateral public.tier_limits(current_profile.tier) limits
        where (
          select count(*)
          from public.connections active_connection
          where active_connection.closed_at is null
            and (active_connection.user_a = member.user_id
              or active_connection.user_b = member.user_id)
        ) >= limits.open_connections
      ) or exists (
        select 1 from halal_mode_private.pair_exposure pe
        where pe.user_low = least(e.a, e.b) and pe.user_high = greatest(e.a, e.b)
          and (pe.retired_at is not null or pe.times_shown >= v_max_appearances
            or (pe.cooldown_until is not null and pe.cooldown_until > p_at))
      )
    ) then
      raise exception 'MATCHING_LATE_VETO: current safety state vetoes a frozen matching edge'
        using errcode = '40001';
    end if;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Frozen matching edges contain malformed values'
        using errcode = '22023';
  end;
end;
$$;
