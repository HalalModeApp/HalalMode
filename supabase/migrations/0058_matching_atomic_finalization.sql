-- Reciprocal matching v1: atomic, idempotent run finalization.
--
-- A successful live run now has one database transaction that validates the
-- frozen plan, writes both reciprocal halves, records outcomes/exposure and
-- retirements, derives authoritative metrics from stored rows, and marks the
-- run finished. A lost HTTP response can therefore be retried without making
-- a second round. Shadow finalization has the same retry contract but can
-- write only matching_runs and shadow_round_edges.

alter table halal_mode_private.matching_runs
  add column if not exists finalization_hash text,
  add column if not exists finalization_result jsonb;

alter table halal_mode_private.matching_runs
  drop constraint if exists matching_runs_finalization_result_check;
alter table halal_mode_private.matching_runs
  add constraint matching_runs_finalization_result_check check (
    finalization_result is null or jsonb_typeof(finalization_result) = 'object'
  );

create unique index if not exists matching_runs_one_successful_live_cycle_idx
  on halal_mode_private.matching_runs (cycle_date)
  where mode = 'live' and finalization_hash is not null and error is null;

create table halal_mode_private.matching_run_rounds (
  run_id uuid not null references halal_mode_private.matching_runs(id) on delete cascade,
  round_id uuid not null references public.rounds(id) on delete cascade,
  primary key (run_id, round_id),
  unique (round_id)
);

revoke all on table halal_mode_private.matching_run_rounds
  from public, anon, authenticated, service_role;

comment on table halal_mode_private.matching_run_rounds is
  'Private provenance for rounds created by one atomic live matching run; used to derive authoritative counts and retry results.';

create or replace function halal_mode_private.matching_finalize_hash(
  p_mode text,
  p_edges jsonb,
  p_outcomes jsonb,
  p_retirements jsonb,
  p_expires_at timestamptz,
  p_stage_latencies jsonb,
  p_peak_memory_bytes bigint,
  p_threshold_breaches jsonb
) returns text
language sql
immutable
security definer
set search_path = pg_catalog, extensions as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'mode', p_mode,
    'edges', coalesce((
      select jsonb_agg(e order by
        least((e ->> 'a')::uuid, (e ->> 'b')::uuid),
        greatest((e ->> 'a')::uuid, (e ->> 'b')::uuid)
      ) from jsonb_array_elements(p_edges) e
    ), '[]'::jsonb),
    'outcomes', coalesce((
      select jsonb_agg(o order by (o ->> 'user_id')::uuid)
      from jsonb_array_elements(coalesce(p_outcomes, '[]'::jsonb)) o
    ), '[]'::jsonb),
    'retirements', coalesce((
      select jsonb_agg(r order by
        least((r ->> 'user_low')::uuid, (r ->> 'user_high')::uuid),
        greatest((r ->> 'user_low')::uuid, (r ->> 'user_high')::uuid)
      ) from jsonb_array_elements(coalesce(p_retirements, '[]'::jsonb)) r
    ), '[]'::jsonb),
    'expires_at', p_expires_at,
    'stage_latencies', p_stage_latencies,
    'peak_memory_bytes', p_peak_memory_bytes,
    'threshold_breaches', coalesce((
      select jsonb_agg(v order by v::text)
      from jsonb_array_elements(p_threshold_breaches) v
    ), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex');
$$;

revoke all on function halal_mode_private.matching_finalize_hash(
  text, jsonb, jsonb, jsonb, timestamptz, jsonb, bigint, jsonb
) from public, anon, authenticated, service_role;

-- Every mutable table consulted by final validation participates in the same
-- advisory-lock protocol. This is necessary because row locks cannot exclude
-- a concurrent insert for a block/pass/connection that does not exist yet.
create or replace function halal_mode_private.lock_matching_pair_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog as $$
declare
  v_new jsonb := coalesce(to_jsonb(new), '{}'::jsonb);
  v_old jsonb := coalesce(to_jsonb(old), '{}'::jsonb);
  v_user uuid;
  v_pair record;
begin
  for v_user in
    select distinct value::uuid
    from unnest(array[
      nullif(v_new ->> tg_argv[0], ''), nullif(v_new ->> tg_argv[1], ''),
      nullif(v_old ->> tg_argv[0], ''), nullif(v_old ->> tg_argv[1], '')
    ]) value
    where value is not null
    order by value::uuid
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;

  for v_pair in
    select distinct least(a, b) user_low, greatest(a, b) user_high
    from (
      values
        (nullif(v_new ->> tg_argv[0], '')::uuid, nullif(v_new ->> tg_argv[1], '')::uuid),
        (nullif(v_old ->> tg_argv[0], '')::uuid, nullif(v_old ->> tg_argv[1], '')::uuid)
    ) pairs(a, b)
    where a is not null and b is not null
    order by user_low, user_high
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      v_pair.user_low::text || ':' || v_pair.user_high::text, 5811
    ));
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function halal_mode_private.lock_matching_consent_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog as $$
declare
  v_new jsonb := coalesce(to_jsonb(new), '{}'::jsonb);
  v_old jsonb := coalesce(to_jsonb(old), '{}'::jsonb);
  v_user uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('matching-legal-consent-epoch', 5810));
  for v_user in
    select distinct value::uuid
    from unnest(array[
      nullif(v_new ->> 'user_id', ''), nullif(v_old ->> 'user_id', '')
    ]) value
    where value is not null
    order by value::uuid
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function halal_mode_private.lock_matching_consent_registry_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('matching-legal-consent-epoch', 5810));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function halal_mode_private.lock_matching_member_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog as $$
declare
  v_new jsonb := coalesce(to_jsonb(new), '{}'::jsonb);
  v_old jsonb := coalesce(to_jsonb(old), '{}'::jsonb);
  v_user uuid;
begin
  for v_user in
    select distinct value::uuid
    from unnest(array[
      nullif(v_new ->> tg_argv[0], ''), nullif(v_old ->> tg_argv[0], '')
    ]) value
    where value is not null order by value::uuid
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function halal_mode_private.lock_matching_finalization_plan(
  p_edges jsonb,
  p_retirements jsonb default '[]'::jsonb
) returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog as $$
declare
  v_user uuid;
  v_pair record;
begin
  perform pg_advisory_xact_lock(hashtextextended('matching-legal-consent-epoch', 5810));
  for v_user in
    with pairs as (
      select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b
      from jsonb_array_elements(p_edges) e
      union all
      select (r ->> 'user_low')::uuid, (r ->> 'user_high')::uuid
      from jsonb_array_elements(coalesce(p_retirements, '[]'::jsonb)) r
    )
    select distinct member_id
    from pairs cross join lateral (values (a), (b)) member(member_id)
    order by member_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;
  for v_pair in
    with pairs as (
      select (e ->> 'a')::uuid a, (e ->> 'b')::uuid b
      from jsonb_array_elements(p_edges) e
      union all
      select (r ->> 'user_low')::uuid, (r ->> 'user_high')::uuid
      from jsonb_array_elements(coalesce(p_retirements, '[]'::jsonb)) r
    )
    select distinct least(a, b) user_low, greatest(a, b) user_high
    from pairs order by user_low, user_high
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      v_pair.user_low::text || ':' || v_pair.user_high::text, 5811
    ));
  end loop;
end;
$$;

revoke all on function halal_mode_private.lock_matching_pair_mutation()
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.lock_matching_consent_mutation()
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.lock_matching_consent_registry_mutation()
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.lock_matching_member_mutation()
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.lock_matching_finalization_plan(jsonb,jsonb)
  from public, anon, authenticated, service_role;

drop trigger if exists matching_pair_lock_blocks on public.blocks;
create trigger matching_pair_lock_blocks before insert or update or delete on public.blocks
for each row execute function halal_mode_private.lock_matching_pair_mutation('blocker_id', 'blocked_id');
drop trigger if exists matching_member_lock_profiles on public.profiles;
create trigger matching_member_lock_profiles before insert or update of is_paused, tier or delete
on public.profiles for each row
execute function halal_mode_private.lock_matching_member_mutation('id');
drop trigger if exists matching_pair_lock_selections on public.introduction_selections;
create trigger matching_pair_lock_selections before insert or update or delete on public.introduction_selections
for each row execute function halal_mode_private.lock_matching_pair_mutation('viewer_id', 'subject_id');
drop trigger if exists matching_pair_lock_connections on public.connections;
create trigger matching_pair_lock_connections before insert or update or delete on public.connections
for each row execute function halal_mode_private.lock_matching_pair_mutation('user_a', 'user_b');
drop trigger if exists matching_pair_lock_exposure on halal_mode_private.pair_exposure;
create trigger matching_pair_lock_exposure before insert or update or delete on halal_mode_private.pair_exposure
for each row execute function halal_mode_private.lock_matching_pair_mutation('user_low', 'user_high');
drop trigger if exists matching_consent_lock_history on halal_mode_private.member_legal_consent_history;
create trigger matching_consent_lock_history before insert or update or delete
on halal_mode_private.member_legal_consent_history
for each row execute function halal_mode_private.lock_matching_consent_mutation();
drop trigger if exists matching_consent_lock_registry on halal_mode_private.legal_document_registry;
create trigger matching_consent_lock_registry before insert or update or delete
on halal_mode_private.legal_document_registry
for each row execute function halal_mode_private.lock_matching_consent_registry_mutation();

-- Finalization trusts the immutable candidate snapshot for ordinary matching
-- inputs (profile and preference edits must not make later pages disagree with
-- earlier pages), while current safety/control state can still veto a write.
-- Scores are produced by the trusted service process; the database enforces
-- the run config floor and exact fairness ceiling but intentionally does not
-- duplicate the estimator implementation in SQL.
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
begin
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
  perform pg_advisory_xact_lock(hashtextextended('matching-legal-consent-epoch', 5810));
  for v_user in
    select distinct member_id
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    cross join lateral (values (e.a), (e.b)) member(member_id)
    order by member_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;
  for v_pair in
    select distinct least(e.a, e.b) as user_low, greatest(e.a, e.b) as user_high
    from jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
    order by user_low, user_high
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      v_pair.user_low::text || ':' || v_pair.user_high::text, 5811
    ));
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

create or replace function halal_mode_private.persist_frozen_matching_round(
  p_run_id uuid,
  p_edges jsonb,
  p_outcomes jsonb,
  p_expires_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_user uuid;
  v_created integer;
  v_cooldown_days integer;
begin
  drop table if exists pg_temp.hm_v1_edges;
  drop table if exists pg_temp.hm_v1_outcomes;
  drop table if exists pg_temp.hm_v1_rounds;
  create temporary table hm_v1_edges (
    a uuid not null, b uuid not null, score numeric not null, utility numeric not null,
    intro_a uuid not null, intro_b uuid not null
  ) on commit drop;
  create temporary table hm_v1_outcomes (user_id uuid not null, outcome text not null) on commit drop;
  create temporary table hm_v1_rounds (
    user_id uuid primary key, round_id uuid not null, tier public.membership_tier not null
  ) on commit drop;

  insert into hm_v1_edges
  select e.a, e.b, e.score, e.utility, gen_random_uuid(), gen_random_uuid()
  from jsonb_to_recordset(p_edges) as e(a uuid,b uuid,score numeric,utility numeric);
  insert into hm_v1_outcomes
  select o.user_id, o.outcome
  from jsonb_to_recordset(p_outcomes) as o(user_id uuid,outcome text);

  if exists (
    select 1 from hm_v1_outcomes o
    where (o.outcome = 'served') is distinct from exists (
      select 1 from hm_v1_edges e where e.a = o.user_id or e.b = o.user_id
    )
  ) then
    raise exception 'Served outcomes must exactly match chosen edge members'
      using errcode = '22023';
  end if;

  insert into hm_v1_rounds (user_id, round_id, tier)
  select o.user_id, gen_random_uuid(), profile.tier
  from hm_v1_outcomes o
  join public.profiles profile on profile.id = o.user_id
  where o.outcome = 'served';

  insert into public.rounds (id, user_id, tier, expires_at)
  select round_id, user_id, tier, p_expires_at from hm_v1_rounds;

  insert into public.introductions (
    id, round_id, viewer_id, subject_id, reciprocal_id, agreements
  )
  select e.intro_a, ra.round_id, e.a, e.b, e.intro_b,
         public.agreement_summary(e.a, e.b)
  from hm_v1_edges e join hm_v1_rounds ra on ra.user_id = e.a
  union all
  select e.intro_b, rb.round_id, e.b, e.a, e.intro_a,
         public.agreement_summary(e.b, e.a)
  from hm_v1_edges e join hm_v1_rounds rb on rb.user_id = e.b;

  select (mc.params ->> 'repeat_cooldown_days')::integer into v_cooldown_days
  from halal_mode_private.matching_runs r
  join halal_mode_private.matching_config mc on mc.version = r.config_version
  where r.id = p_run_id;

  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, times_shown, first_reciprocal_score,
    last_reciprocal_score, last_shown_at, last_round_id, cooldown_until
  )
  select least(e.a,e.b), greatest(e.a,e.b), 1, e.score, e.score, now(),
         r.round_id, now() + make_interval(days => v_cooldown_days)
  from hm_v1_edges e join hm_v1_rounds r on r.user_id = least(e.a,e.b)
  on conflict (user_low,user_high) do update set
    times_shown = pe.times_shown + 1,
    last_reciprocal_score = excluded.last_reciprocal_score,
    last_shown_at = excluded.last_shown_at,
    last_round_id = excluded.last_round_id,
    cooldown_until = excluded.cooldown_until;

  insert into halal_mode_private.matching_member_run_outcomes (
    run_id,user_id,outcome,valid_until
  ) select p_run_id,user_id,outcome,p_expires_at from hm_v1_outcomes;

  select count(*)::integer into v_created from hm_v1_edges;
  return v_created;
end;
$$;

revoke all on function halal_mode_private.validate_frozen_matching_edges(uuid,jsonb,timestamptz)
  from public,anon,authenticated,service_role;
revoke all on function halal_mode_private.persist_frozen_matching_round(uuid,jsonb,jsonb,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function halal_mode_private.matching_diagnostics_are_valid(
  p_stage_latencies jsonb,
  p_threshold_breaches jsonb
) returns boolean
language sql
immutable
security definer
set search_path = pg_catalog as $$
  select jsonb_typeof(p_stage_latencies) = 'object'
    and not exists (
      select 1 from jsonb_each(p_stage_latencies) stage
      where stage.key !~ '^[a-z][a-z0-9_]{0,63}$'
         or jsonb_typeof(stage.value) <> 'number'
         or (stage.value #>> '{}')::numeric < 0
    )
    and jsonb_typeof(p_threshold_breaches) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(p_threshold_breaches) breach
      where jsonb_typeof(breach) <> 'string'
         or breach #>> '{}' not in (
           'warn_edges_after_filter', 'fail_edges_after_filter',
           'warn_round_latency_ms', 'fail_round_latency_ms',
           'warn_peak_memory_bytes', 'fail_peak_memory_bytes',
           'candidate_fetch_failed'
         )
    );
$$;

revoke all on function halal_mode_private.matching_diagnostics_are_valid(jsonb,jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.matching_live_finalize_service(
  p_run_id uuid,
  p_edges jsonb,
  p_outcomes jsonb,
  p_retirements jsonb,
  p_expires_at timestamptz,
  p_stage_latencies jsonb,
  p_peak_memory_bytes bigint,
  p_threshold_breaches jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_hash text;
  v_result jsonb;
  v_pairs_created integer;
  v_rounds_created integer;
  v_eligible_members integer;
  v_edges_after_filter integer;
  v_max_appearances integer;
  v_abandon_drop numeric;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Live matching finalization requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null
     or jsonb_typeof(p_edges) is distinct from 'array'
     or jsonb_typeof(p_outcomes) is distinct from 'array'
     or jsonb_typeof(p_retirements) is distinct from 'array'
     or not halal_mode_private.matching_diagnostics_are_valid(
       p_stage_latencies, p_threshold_breaches
     )
     or p_peak_memory_bytes is null or p_peak_memory_bytes < 0
     or p_expires_at is null then
    raise exception 'A complete valid live finalization request is required'
      using errcode = '22023';
  end if;

  begin
    v_hash := halal_mode_private.matching_finalize_hash(
      'live', p_edges, p_outcomes, p_retirements, p_expires_at,
      p_stage_latencies, p_peak_memory_bytes, p_threshold_breaches
    );
  exception when others then
    raise exception 'Live finalization contains malformed identifiers or metrics'
      using errcode = '22023';
  end;

  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 5801));
  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id
  for update;

  if v_run.id is null or v_run.mode <> 'live' or v_run.cycle_date is null then
    raise exception 'A snapshot-capable live matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    if v_run.error is null
       and v_run.finalization_hash = v_hash
       and v_run.finalization_result is not null then
      return v_run.finalization_result || jsonb_build_object('idempotent', true);
    end if;
    raise exception 'A finished live run cannot be finalized with a different request'
      using errcode = '40001';
  end if;
  if p_expires_at <= now() then
    raise exception 'A future round expiry is required'
      using errcode = '22023';
  end if;
  if v_run.candidate_snapshot_prepared_at is null then
    raise exception 'Prepare the matching snapshot before live finalization'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from halal_mode_private.matching_runs other
    where other.id <> p_run_id
      and other.mode = 'live'
      and other.cycle_date = v_run.cycle_date
      and other.finalization_hash is not null
      and other.error is null
  ) then
    raise exception 'This cycle already has a successful live matching run'
      using errcode = '23505';
  end if;
  -- The legacy inner writer still reads the active cooldown/repeat values.
  -- Refuse rather than mixing versions if activation changes mid-run.
  if v_run.config_version is distinct from
       halal_mode_private.active_matching_config_version() then
    raise exception 'The active matching configuration changed during the run'
      using errcode = '40001';
  end if;

  perform halal_mode_private.lock_matching_finalization_plan(p_edges, p_retirements);
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());

  drop table if exists pg_temp.hm_v1_final_outcomes;
  drop table if exists pg_temp.hm_v1_retirements;
  create temporary table hm_v1_final_outcomes (
    user_id uuid not null,
    outcome text not null
  ) on commit drop;
  create temporary table hm_v1_retirements (
    user_low uuid not null,
    user_high uuid not null,
    reason text not null,
    current_score numeric not null
  ) on commit drop;

  begin
    insert into hm_v1_final_outcomes (user_id, outcome)
    select o.user_id, o.outcome
    from jsonb_to_recordset(p_outcomes) as o(user_id uuid, outcome text);
    insert into hm_v1_retirements (user_low, user_high, reason, current_score)
    select least(r.user_low, r.user_high), greatest(r.user_low, r.user_high),
           r.reason, r.current_score
    from jsonb_to_recordset(p_retirements)
      as r(user_low uuid, user_high uuid, reason text, current_score numeric);
  exception when others then
    raise exception 'Malformed outcomes or retirement proposals'
      using errcode = '22023';
  end;

  if exists (
    select 1 from hm_v1_final_outcomes
    where user_id is null or outcome not in ('served', 'deferred', 'no_candidate')
  ) or exists (
    select 1 from hm_v1_final_outcomes group by user_id having count(*) > 1
  ) or exists (
    select 1
    from (
      select user_id
      from halal_mode_private.matching_run_member_snapshots
      where run_id = p_run_id
    ) m
    full join hm_v1_final_outcomes o
      on o.user_id = m.user_id
    where m.user_id is null or o.user_id is null
  ) then
    raise exception 'Outcomes must cover every snapshotted member exactly once'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from hm_v1_retirements
    where user_low >= user_high
      or reason not in ('repeat_limit', 'score_collapse')
      or current_score < 0 or current_score > 1
  ) or exists (
    select 1 from hm_v1_retirements
    group by user_low, user_high having count(*) > 1
  ) or exists (
    select 1
    from hm_v1_retirements r
    join jsonb_to_recordset(p_edges) as e(a uuid, b uuid, score numeric, utility numeric)
      on least(e.a, e.b) = r.user_low and greatest(e.a, e.b) = r.user_high
  ) then
    raise exception 'Retirement proposals must be unique, valid, and outside the chosen plan'
      using errcode = '22023';
  end if;

  select (params ->> 'max_pair_appearances')::integer,
         (params ->> 'repeat_abandon_drop')::numeric
  into v_max_appearances, v_abandon_drop
  from halal_mode_private.matching_config
  where version = v_run.config_version;

  if exists (
    select 1
    from hm_v1_retirements r
    left join halal_mode_private.pair_exposure pe
      on pe.user_low = r.user_low and pe.user_high = r.user_high
    where pe.user_low is null
       or (r.reason = 'repeat_limit' and pe.times_shown < v_max_appearances)
       or (r.reason = 'score_collapse' and (
         pe.first_reciprocal_score is null
         or pe.times_shown < 1
         or pe.first_reciprocal_score - r.current_score < v_abandon_drop
         or not exists (
           select 1
           from halal_mode_private.matching_run_candidate_snapshots c
           where c.run_id = p_run_id
             and c.user_low = r.user_low and c.user_high = r.user_high
         )
       ))
  ) then
    raise exception 'A retirement proposal is not supported by stored pair history'
      using errcode = '40001';
  end if;

  update halal_mode_private.pair_exposure pe
  set retired_at = coalesce(pe.retired_at, now()),
      retired_reason = coalesce(pe.retired_reason, r.reason)
  from hm_v1_retirements r
  where pe.user_low = r.user_low and pe.user_high = r.user_high;

  perform halal_mode_private.persist_frozen_matching_round(
    p_run_id, p_edges, p_outcomes, p_expires_at
  );

  -- The all-or-nothing writer leaves its generated round ids in a transaction
  -- temporary table. Link them before commit so counts never depend on a
  -- caller claim or a timestamp heuristic.
  insert into halal_mode_private.matching_run_rounds (run_id, round_id)
  select p_run_id, round_id from pg_temp.hm_v1_rounds;

  -- Reaching the repeat limit on this very appearance retires the pair in the
  -- same transaction. Shadow never executes this path.
  update halal_mode_private.pair_exposure pe
  set retired_at = coalesce(pe.retired_at, now()),
      retired_reason = coalesce(pe.retired_reason, 'repeat_limit')
  where pe.times_shown >= v_max_appearances
    and exists (
      select 1 from halal_mode_private.matching_run_rounds rr
      where rr.run_id = p_run_id and rr.round_id = pe.last_round_id
    );

  select count(*)::integer into v_rounds_created
  from halal_mode_private.matching_run_rounds where run_id = p_run_id;
  select (count(*) / 2)::integer into v_pairs_created
  from public.introductions i
  join halal_mode_private.matching_run_rounds rr on rr.round_id = i.round_id
  where rr.run_id = p_run_id;
  select count(*)::integer into v_eligible_members
  from halal_mode_private.matching_run_member_snapshots where run_id = p_run_id;
  select count(*)::integer into v_edges_after_filter
  from halal_mode_private.matching_run_candidate_snapshots where run_id = p_run_id;

  v_result := jsonb_build_object(
    'pairs_created', v_pairs_created,
    'rounds_created', v_rounds_created,
    'eligible_members', v_eligible_members,
    'edges_after_filter', v_edges_after_filter
  );

  update halal_mode_private.matching_runs
  set finished_at = now(),
      eligible_members = v_eligible_members,
      edges_after_filter = v_edges_after_filter,
      pairs_created = v_pairs_created,
      rounds_created = v_rounds_created,
      stage_latencies = p_stage_latencies,
      peak_memory_bytes = p_peak_memory_bytes,
      threshold_breaches = p_threshold_breaches,
      error = null,
      finalization_hash = v_hash,
      finalization_result = v_result
  where id = p_run_id;

  return v_result || jsonb_build_object('idempotent', false);
end;
$$;

create or replace function public.matching_shadow_finalize_service(
  p_run_id uuid,
  p_edges jsonb,
  p_stage_latencies jsonb,
  p_peak_memory_bytes bigint,
  p_threshold_breaches jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_hash text;
  v_result jsonb;
  v_pairs_created integer;
  v_rounds_created integer;
  v_eligible_members integer;
  v_edges_after_filter integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Shadow matching finalization requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null
     or jsonb_typeof(p_edges) is distinct from 'array'
     or not halal_mode_private.matching_diagnostics_are_valid(
       p_stage_latencies, p_threshold_breaches
     )
     or p_peak_memory_bytes is null or p_peak_memory_bytes < 0 then
    raise exception 'A complete valid shadow finalization request is required'
      using errcode = '22023';
  end if;

  begin
    v_hash := halal_mode_private.matching_finalize_hash(
      'shadow', p_edges, '[]'::jsonb, '[]'::jsonb, null,
      p_stage_latencies, p_peak_memory_bytes, p_threshold_breaches
    );
  exception when others then
    raise exception 'Shadow finalization contains malformed identifiers or metrics'
      using errcode = '22023';
  end;

  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 5801));
  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id
  for update;

  if v_run.id is null or v_run.mode <> 'shadow' or v_run.cycle_date is null then
    raise exception 'A snapshot-capable shadow matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    if v_run.error is null
       and v_run.finalization_hash = v_hash
       and v_run.finalization_result is not null then
      return v_run.finalization_result || jsonb_build_object('idempotent', true);
    end if;
    raise exception 'A finished shadow run cannot be finalized with a different request'
      using errcode = '40001';
  end if;
  if v_run.candidate_snapshot_prepared_at is null then
    raise exception 'Prepare the matching snapshot before shadow finalization'
      using errcode = '55000';
  end if;
  if v_run.config_version is distinct from
       halal_mode_private.active_matching_config_version() then
    raise exception 'The active matching configuration changed during the run'
      using errcode = '40001';
  end if;

  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());
  perform halal_mode_private.persist_validated_shadow_edges(p_run_id, p_edges);

  select (count(*) / 2)::integer into v_pairs_created
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  select count(distinct viewer_id)::integer into v_rounds_created
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  select count(*)::integer into v_eligible_members
  from halal_mode_private.matching_run_member_snapshots where run_id = p_run_id;
  select count(*)::integer into v_edges_after_filter
  from halal_mode_private.matching_run_candidate_snapshots where run_id = p_run_id;

  v_result := jsonb_build_object(
    'pairs_created', v_pairs_created,
    'rounds_created', v_rounds_created,
    'eligible_members', v_eligible_members,
    'edges_after_filter', v_edges_after_filter
  );

  update halal_mode_private.matching_runs
  set finished_at = now(),
      eligible_members = v_eligible_members,
      edges_after_filter = v_edges_after_filter,
      pairs_created = v_pairs_created,
      rounds_created = v_rounds_created,
      stage_latencies = p_stage_latencies,
      peak_memory_bytes = p_peak_memory_bytes,
      threshold_breaches = p_threshold_breaches,
      error = null,
      finalization_hash = v_hash,
      finalization_result = v_result
  where id = p_run_id;

  return v_result || jsonb_build_object('idempotent', false);
end;
$$;

-- The old completion method is now failure-only. Successful counts are
-- derived inside the atomic finalizers and can never be overwritten by a
-- second network call or by caller-supplied numbers.
create or replace function public.matching_run_finish(
  p_run_id uuid,
  p_eligible_members integer,
  p_edges_after_filter integer,
  p_pairs_created integer,
  p_rounds_created integer,
  p_stage_latencies jsonb,
  p_peak_memory_bytes bigint,
  p_threshold_breaches jsonb,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_eligible integer;
  v_edges integer;
  v_pairs integer;
  v_rounds integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching run completion requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null or nullif(btrim(p_error), '') is null then
    raise exception 'matching_run_finish records failures only'
      using errcode = '22023';
  end if;
  if not halal_mode_private.matching_diagnostics_are_valid(
       p_stage_latencies, p_threshold_breaches
     )
     or (p_peak_memory_bytes is not null and p_peak_memory_bytes < 0) then
    raise exception 'Matching failure diagnostics are malformed'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 5801));
  select * into v_run
  from halal_mode_private.matching_runs where id = p_run_id for update;
  if v_run.id is null or v_run.finished_at is not null
     or v_run.finalization_hash is not null then
    raise exception 'A successful or finished run cannot be overwritten'
      using errcode = '40001';
  end if;

  select count(*)::integer into v_eligible
  from halal_mode_private.matching_run_member_snapshots where run_id = p_run_id;
  select count(*)::integer into v_edges
  from halal_mode_private.matching_run_candidate_snapshots where run_id = p_run_id;
  select count(*)::integer into v_rounds
  from halal_mode_private.matching_run_rounds where run_id = p_run_id;
  if v_run.mode = 'shadow' then
    select (count(*) / 2)::integer into v_pairs
    from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  else
    select (count(*) / 2)::integer into v_pairs
    from public.introductions i
    join halal_mode_private.matching_run_rounds rr on rr.round_id = i.round_id
    where rr.run_id = p_run_id;
  end if;

  if (p_eligible_members is not null and p_eligible_members <> v_eligible)
     or (p_edges_after_filter is not null and p_edges_after_filter <> v_edges)
     or (p_pairs_created is not null and p_pairs_created <> v_pairs)
     or (p_rounds_created is not null and p_rounds_created <> v_rounds) then
    raise exception 'Caller metrics contradict stored run truth'
      using errcode = '22023';
  end if;

  update halal_mode_private.matching_runs
  set finished_at = now(),
      eligible_members = v_eligible,
      edges_after_filter = v_edges,
      pairs_created = v_pairs,
      rounds_created = v_rounds,
      stage_latencies = p_stage_latencies,
      peak_memory_bytes = p_peak_memory_bytes,
      threshold_breaches = p_threshold_breaches,
      error = left(p_error, 2000)
  where id = p_run_id;
end;
$$;

revoke all on function public.matching_live_finalize_service(
  uuid, jsonb, jsonb, jsonb, timestamptz, jsonb, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.matching_shadow_finalize_service(
  uuid, jsonb, jsonb, bigint, jsonb
) from public, anon, authenticated;
revoke execute on function public.persist_matching_round_service(
  uuid, jsonb, jsonb, timestamptz
) from service_role;
revoke execute on function public.matching_shadow_round_service(uuid, jsonb)
  from service_role;

grant execute on function public.matching_live_finalize_service(
  uuid, jsonb, jsonb, jsonb, timestamptz, jsonb, bigint, jsonb
) to service_role;
grant execute on function public.matching_shadow_finalize_service(
  uuid, jsonb, jsonb, bigint, jsonb
) to service_role;

revoke all on function public.matching_run_finish(
  uuid, integer, integer, integer, integer, jsonb, bigint, jsonb, text
) from public, anon, authenticated;
grant execute on function public.matching_run_finish(
  uuid, integer, integer, integer, integer, jsonb, bigint, jsonb, text
) to service_role;
