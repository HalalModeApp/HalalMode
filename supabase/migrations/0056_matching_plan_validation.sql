-- Reciprocal matching v1: authoritative plan validation and history backfill.
--
-- Candidate retrieval and both persistence modes must agree on pair
-- eligibility.  A plan produced from stale or fabricated inputs is rejected at
-- the final database boundary; shadow uses the same read-only validator but
-- still has no write path to any live product table.

-- Existing introductions predate pair_exposure. Backfill one undirected
-- appearance per reciprocal twin (and at least one for an orphan card), so a
-- previously shown pair is never treated as new merely because v1 was added.
-- The helper is retained privately so pgTAP can prove idempotence against data
-- created inside its transaction.
create or replace function halal_mode_private.backfill_pair_exposure()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_rows integer;
begin
with cfg as (
  select
    (halal_mode_private.active_matching_config() ->> 'max_pair_appearances')::integer as max_appearances,
    (halal_mode_private.active_matching_config() ->> 'repeat_cooldown_days')::integer as cooldown_days
), historic as (
  select
    least(i.viewer_id, i.subject_id) as user_low,
    greatest(i.viewer_id, i.subject_id) as user_high,
    count(distinct case
      when i.reciprocal_id is null then i.id
      else least(i.id, i.reciprocal_id)
    end)::integer as times_shown,
    max(i.created_at) as last_shown_at
  from public.introductions i
  group by least(i.viewer_id, i.subject_id), greatest(i.viewer_id, i.subject_id)
), prepared as (
  select
    h.*,
    h.last_shown_at + make_interval(days => cfg.cooldown_days) as cooldown_until,
    case when h.times_shown >= cfg.max_appearances then h.last_shown_at end as retired_at,
    case when h.times_shown >= cfg.max_appearances then 'historical_repeat_limit' end as retired_reason
  from historic h cross join cfg
)
insert into halal_mode_private.pair_exposure as pe (
  user_low, user_high, times_shown, last_shown_at, cooldown_until,
  retired_at, retired_reason
)
select
  user_low, user_high, greatest(times_shown, 1), last_shown_at,
  cooldown_until, retired_at, retired_reason
from prepared
on conflict (user_low, user_high) do update set
  times_shown = greatest(pe.times_shown, excluded.times_shown),
  last_shown_at = greatest(pe.last_shown_at, excluded.last_shown_at),
  cooldown_until = greatest(pe.cooldown_until, excluded.cooldown_until),
  retired_at = coalesce(pe.retired_at, excluded.retired_at),
  retired_reason = coalesce(pe.retired_reason, excluded.retired_reason);
get diagnostics v_rows = row_count;
return v_rows;
end;
$$;

select halal_mode_private.backfill_pair_exposure();

create or replace function halal_mode_private.matching_pair_is_eligible(
  p_user_a uuid,
  p_user_b uuid,
  p_at timestamptz,
  p_config_version integer
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
  select p_user_a is not null
    and p_user_b is not null
    and p_user_a <> p_user_b
    and p_at is not null
    and exists (
      select 1 from halal_mode_private.matching_config mc
      where mc.version = p_config_version
    )
    and exists (
      select 1
      from halal_mode_private.matching_pool a
      join halal_mode_private.matching_pool b on b.id = p_user_b
      where a.id = p_user_a
        and a.gender <> b.gender
    )
    and public.passes_criteria(p_user_a, p_user_b)
    and public.passes_criteria(p_user_b, p_user_a)
    -- A connection is permanent pair history. Closed rows count too: the
    -- unique pair constraint means the pair cannot cleanly reconnect, and a
    -- former connection must not unexpectedly reappear in introductions.
    and not exists (
      select 1 from public.connections c
      where c.user_a = least(p_user_a, p_user_b)
        and c.user_b = greatest(p_user_a, p_user_b)
    )
    and not exists (
      select 1 from public.blocks bl
      where (bl.blocker_id = p_user_a and bl.blocked_id = p_user_b)
         or (bl.blocker_id = p_user_b and bl.blocked_id = p_user_a)
    )
    and not exists (
      select 1 from public.introduction_selections s
      where s.decision = 'explicit_pass'
        and ((s.viewer_id = p_user_a and s.subject_id = p_user_b)
          or (s.viewer_id = p_user_b and s.subject_id = p_user_a))
    )
    and not exists (
      select 1
      from halal_mode_private.pair_exposure pe
      cross join halal_mode_private.matching_config mc
      where pe.user_low = least(p_user_a, p_user_b)
        and pe.user_high = greatest(p_user_a, p_user_b)
        and mc.version = p_config_version
        and (
          pe.retired_at is not null
          or pe.times_shown >= (mc.params ->> 'max_pair_appearances')::integer
          or (pe.cooldown_until is not null and pe.cooldown_until > p_at)
        )
    );
$$;

comment on function halal_mode_private.matching_pair_is_eligible(uuid, uuid, timestamptz, integer) is
  'Shared read-only eligibility authority for candidate retrieval and live/shadow plan validation.';

create or replace function halal_mode_private.validate_matching_edges(
  p_run_id uuid,
  p_edges jsonb,
  p_at timestamptz default now()
) returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_config jsonb;
  v_min_score numeric;
  v_boost_cap numeric;
begin
  select * into v_run from halal_mode_private.matching_runs
  where id = p_run_id;
  if v_run.id is null or v_run.finished_at is not null
     or v_run.mode not in ('live', 'shadow') then
    raise exception 'An unfinished matching run is required'
      using errcode = '22023';
  end if;
  select params into v_config from halal_mode_private.matching_config
  where version = v_run.config_version;
  if v_config is null then
    raise exception 'The run matching configuration is unavailable'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_edges) is distinct from 'array' or p_at is null then
    raise exception 'Matching edges must be an array' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_edges) e
    where jsonb_typeof(e) <> 'object'
      or not (e ?& array['a', 'b', 'score', 'utility'])
      or (e ->> 'a') is null or (e ->> 'b') is null
      or (e ->> 'score') is null or (e ->> 'utility') is null
  ) then
    raise exception 'Every matching edge requires a, b, score, and utility'
      using errcode = '22023';
  end if;

  v_min_score := (v_config ->> 'min_reciprocal_score')::numeric;
  v_boost_cap := (v_config ->> 'boost_cap')::numeric;

  begin
    if exists (
      with parsed as materialized (
        select (e ->> 'a')::uuid as a, (e ->> 'b')::uuid as b,
               (e ->> 'score')::numeric as score,
               (e ->> 'utility')::numeric as utility
        from jsonb_array_elements(p_edges) e
      )
      select 1 from parsed
      where a = b
         or score < v_min_score or score > 1
         or utility < 0
         -- The boost delta is bounded by score * boost_cap. Repeat decay may
         -- make utility lower than score, so there is intentionally no lower
         -- bound of utility >= score.
         or utility > score * (1 + v_boost_cap)
         or not halal_mode_private.matching_pair_is_eligible(
           a, b, p_at, v_run.config_version
         )
    ) then
      raise exception 'A matching edge violates eligibility or active score limits'
        using errcode = '40001';
    end if;

    if exists (
      with parsed as (
        select least((e ->> 'a')::uuid, (e ->> 'b')::uuid) as user_low,
               greatest((e ->> 'a')::uuid, (e ->> 'b')::uuid) as user_high
        from jsonb_array_elements(p_edges) e
      )
      select 1 from parsed
      group by user_low, user_high
      having count(*) > 1
    ) then
      raise exception 'Matching edges contain a duplicate pair'
        using errcode = '22023';
    end if;

    if exists (
      with parsed as materialized (
        select (e ->> 'a')::uuid as a, (e ->> 'b')::uuid as b
        from jsonb_array_elements(p_edges) e
      ), member_counts as (
        select member.user_id, count(*)::integer as edge_count
        from parsed p
        cross join lateral (values (p.a), (p.b)) member(user_id)
        group by member.user_id
      )
      select 1
      from member_counts c
      left join halal_mode_private.matching_pool p on p.id = c.user_id
      where p.id is null or c.edge_count > p.introductions_per_round
    ) then
      raise exception 'A matching plan exceeds member capacity'
        using errcode = '22023';
    end if;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Matching edges contain malformed identifiers or scores'
        using errcode = '22023';
  end;
end;
$$;

-- Candidate retrieval uses the exact same pair authority as both writers.
create or replace function halal_mode_private.matching_candidate_edges(
  p_after_low uuid default null,
  p_after_high uuid default null,
  p_page_size integer default 1000
) returns table (
  user_low uuid,
  user_high uuid,
  compat_low_to_high numeric,
  compat_high_to_low numeric,
  pair_times_shown integer,
  pair_first_score numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
  with cheap as (
    select least(m.id, f.id) as user_low,
           greatest(m.id, f.id) as user_high
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    where m.gender = 'male'
      and (
        p_after_low is null
        or least(m.id, f.id) > p_after_low
        or (least(m.id, f.id) = p_after_low
          and greatest(m.id, f.id) > coalesce(
            p_after_high, '00000000-0000-0000-0000-000000000000'::uuid
          ))
      )
  )
  select c.user_low, c.user_high,
         halal_mode_private.compatibility(c.user_low, c.user_high),
         halal_mode_private.compatibility(c.user_high, c.user_low),
         coalesce(pe.times_shown, 0), pe.first_reciprocal_score
  from cheap c
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = c.user_low and pe.user_high = c.user_high
  where halal_mode_private.matching_pair_is_eligible(
    c.user_low, c.user_high, now(),
    halal_mode_private.active_matching_config_version()
  )
  order by c.user_low, c.user_high
  limit least(greatest(coalesce(p_page_size, 1000), 1), 1000);
$$;

-- Route live persistence through the shared validator before the existing
-- all-or-nothing writer. The service facade remains the only callable path.
create or replace function public.persist_matching_round_service(
  p_run_id uuid,
  p_edges jsonb,
  p_outcomes jsonb,
  p_expires_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Round persistence requires service role' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_outcomes), '') <> 'array'
     or p_expires_at is null or p_expires_at <= now() then
    raise exception 'Matching outcomes and future expiry are required'
      using errcode = '22023';
  end if;

  perform halal_mode_private.validate_matching_edges(p_run_id, p_edges, now());
  return halal_mode_private.persist_matching_round(
    p_run_id, p_edges, p_outcomes, p_expires_at
  );
end;
$$;

-- Preserve the already-audited immutable shadow storage implementation behind
-- a private name, then publish a validating wrapper. The wrapper and its
-- delegate never write introductions, connections, pair exposure, outcomes,
-- or notifications.
alter function public.matching_shadow_round_service(uuid, jsonb)
  set schema halal_mode_private;
alter function halal_mode_private.matching_shadow_round_service(uuid, jsonb)
  rename to persist_validated_shadow_edges;

revoke all on function halal_mode_private.persist_validated_shadow_edges(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.matching_shadow_round_service(
  p_run_id uuid,
  p_edges jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Shadow persistence requires service role' using errcode = '42501';
  end if;

  perform halal_mode_private.validate_matching_edges(p_run_id, p_edges, now());
  return halal_mode_private.persist_validated_shadow_edges(p_run_id, p_edges);
end;
$$;

revoke all on function halal_mode_private.matching_pair_is_eligible(uuid, uuid, timestamptz, integer)
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.validate_matching_edges(uuid, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function halal_mode_private.backfill_pair_exposure()
  from public, anon, authenticated, service_role;
revoke all on function public.persist_matching_round_service(uuid, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
revoke all on function public.matching_shadow_round_service(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_matching_round_service(uuid, jsonb, jsonb, timestamptz)
  to service_role;
grant execute on function public.matching_shadow_round_service(uuid, jsonb)
  to service_role;
