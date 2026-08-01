-- Narrow public service facade for reciprocal matching v1.
--
-- PostgREST exposes functions from `public`, while the matching inputs and
-- outputs deliberately live in `halal_mode_private`. These SECURITY DEFINER
-- functions are the only bridge used by the round Edge Function. Every entry
-- point checks the JWT role as well as relying on grants, so a privileged
-- database connection cannot accidentally exercise it with member claims.

create or replace function public.matching_run_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching service access requires service role'
      using errcode = '42501';
  end if;

  return halal_mode_private.active_matching_config()
    || jsonb_build_object(
      '__version', halal_mode_private.active_matching_config_version()
    );
end;
$$;

create or replace function public.release_flag_active(p_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Release flag service access requires service role'
      using errcode = '42501';
  end if;

  return coalesce(
    (select enabled from halal_mode_private.release_flags where key = p_key),
    false
  );
end;
$$;

create or replace function public.matching_run_start(
  p_algorithm_version text,
  p_config_version integer,
  p_seed bigint,
  p_mode text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, halal_mode_private as $$
declare
  v_run_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching run creation requires service role'
      using errcode = '42501';
  end if;
  if nullif(btrim(p_algorithm_version), '') is null
     or length(p_algorithm_version) > 100 then
    raise exception 'A valid algorithm version is required'
      using errcode = '22023';
  end if;
  if p_mode not in ('live', 'shadow') then
    raise exception 'Matching mode must be live or shadow'
      using errcode = '22023';
  end if;
  if p_config_version is distinct from
       halal_mode_private.active_matching_config_version() then
    raise exception 'Matching run must use the active configuration version'
      using errcode = '22023';
  end if;

  insert into halal_mode_private.matching_runs (
    algorithm_version, config_version, seed, mode
  ) values (
    btrim(p_algorithm_version), p_config_version, p_seed, p_mode
  )
  returning id into v_run_id;

  return v_run_id;
end;
$$;

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
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching run completion requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null then
    raise exception 'A matching run id is required' using errcode = '22023';
  end if;
  if p_eligible_members < 0 or p_edges_after_filter < 0
     or p_pairs_created < 0 or p_rounds_created < 0
     or p_peak_memory_bytes < 0 then
    raise exception 'Matching run metrics cannot be negative'
      using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_stage_latencies), '') <> 'object'
     or coalesce(jsonb_typeof(p_threshold_breaches), '') <> 'array' then
    raise exception 'Matching run latency and breach metrics are malformed'
      using errcode = '22023';
  end if;

  update halal_mode_private.matching_runs
  set finished_at = now(),
      eligible_members = p_eligible_members,
      edges_after_filter = p_edges_after_filter,
      pairs_created = p_pairs_created,
      rounds_created = p_rounds_created,
      stage_latencies = p_stage_latencies,
      peak_memory_bytes = p_peak_memory_bytes,
      threshold_breaches = p_threshold_breaches,
      error = nullif(left(p_error, 2000), '')
  where id = p_run_id
    and finished_at is null;

  if not found then
    raise exception 'Matching run does not exist or is already finished'
      using errcode = '22023';
  end if;
end;
$$;

create or replace function public.matching_candidate_edges_service(
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
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching candidates require service role'
      using errcode = '42501';
  end if;
  if p_page_size is null or p_page_size < 1 or p_page_size > 1000 then
    raise exception 'Matching candidate page size must be between 1 and 1000'
      using errcode = '22023';
  end if;
  if (p_after_low is null) <> (p_after_high is null) then
    raise exception 'Both matching candidate cursors must be provided together'
      using errcode = '22023';
  end if;

  return query
  select c.user_low, c.user_high, c.compat_low_to_high,
         c.compat_high_to_low, c.pair_times_shown, c.pair_first_score
  from halal_mode_private.matching_candidate_edges(
    p_after_low, p_after_high, p_page_size
  ) c;
end;
$$;

create or replace function public.matching_member_signals_service()
returns table (
  user_id uuid,
  gender public.gender,
  tier public.membership_tier,
  times_shown integer,
  times_kept integer,
  rounds_since_last_mutual integer,
  rounds_since_last_served integer,
  exposures_in_window integer,
  introductions_per_round integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching member signals require service role'
      using errcode = '42501';
  end if;

  return query select * from halal_mode_private.matching_member_signals();
end;
$$;

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
    raise exception 'Round persistence requires service role'
      using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_edges), '') <> 'array'
     or coalesce(jsonb_typeof(p_outcomes), '') <> 'array' then
    raise exception 'Matching edges and outcomes must be arrays'
      using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'A future round expiry is required'
      using errcode = '22023';
  end if;

  return halal_mode_private.persist_matching_round(
    p_run_id, p_edges, p_outcomes, p_expires_at
  );
end;
$$;

create or replace function public.matching_shadow_round_service(
  p_run_id uuid,
  p_edges jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, halal_mode_private as $$
declare
  v_pair_count integer;
  v_mode text;
  v_finished_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Shadow persistence requires service role'
      using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_edges), '') <> 'array' then
    raise exception 'Shadow edges must be an array' using errcode = '22023';
  end if;
  select mode, finished_at into v_mode, v_finished_at
  from halal_mode_private.matching_runs
  where id = p_run_id
  for update;
  if v_mode is distinct from 'shadow' or v_finished_at is not null then
    raise exception 'An unfinished shadow run is required'
      using errcode = '22023';
  end if;

  -- Serialize retries for one run. Without this lock, two concurrent requests
  -- could both observe an empty run and append different edge sets.
  perform pg_advisory_xact_lock(hashtextextended(p_run_id::text, 0));
  if exists (
    select 1
    from jsonb_array_elements(p_edges) e
    where jsonb_typeof(e) <> 'object'
      or not (e ?& array['a', 'b', 'score', 'utility'])
      or (e ->> 'a') is null
      or (e ->> 'b') is null
      or (e ->> 'score') is null
      or (e ->> 'utility') is null
  ) then
    raise exception 'Every shadow edge requires a, b, score, and utility'
      using errcode = '22023';
  end if;

  -- Cast once in a materialized CTE. Bad UUIDs/numbers fail the transaction;
  -- self-pairs, out-of-range values, and repeated undirected pairs are rejected
  -- explicitly rather than silently producing misleading shadow evidence.
  with parsed as materialized (
    select
      (e ->> 'a')::uuid as a,
      (e ->> 'b')::uuid as b,
      (e ->> 'score')::numeric as score,
      (e ->> 'utility')::numeric as utility
    from jsonb_array_elements(p_edges) e
  )
  select count(*)::integer into v_pair_count from parsed;

  if exists (
    with parsed as (
      select (e ->> 'a')::uuid as a, (e ->> 'b')::uuid as b,
             (e ->> 'score')::numeric as score,
             (e ->> 'utility')::numeric as utility
      from jsonb_array_elements(p_edges) e
    )
    select 1 from parsed
    where a = b or score < 0 or score > 1 or utility < 0 or utility > 2
  ) then
    raise exception 'Shadow edges contain an invalid pair or score'
      using errcode = '22023';
  end if;

  if exists (
    with parsed as (
      select least((e ->> 'a')::uuid, (e ->> 'b')::uuid) as user_low,
             greatest((e ->> 'a')::uuid, (e ->> 'b')::uuid) as user_high
      from jsonb_array_elements(p_edges) e
    )
    select 1 from parsed group by user_low, user_high having count(*) > 1
  ) then
    raise exception 'Shadow edges contain a duplicate pair'
      using errcode = '22023';
  end if;

  -- Idempotent retries may repeat the exact set. A retry cannot add, remove,
  -- or alter an edge: each run id identifies one immutable calculation.
  if exists (
    select 1 from halal_mode_private.shadow_round_edges where run_id = p_run_id
  ) then
    if (select count(*) from halal_mode_private.shadow_round_edges
        where run_id = p_run_id) <> v_pair_count * 2
       or exists (
         with directed as (
           select (e ->> 'a')::uuid as viewer_id,
                  (e ->> 'b')::uuid as subject_id,
                  (e ->> 'score')::numeric as score,
                  (e ->> 'utility')::numeric as utility
           from jsonb_array_elements(p_edges) e
           union all
           select (e ->> 'b')::uuid, (e ->> 'a')::uuid,
                  (e ->> 'score')::numeric, (e ->> 'utility')::numeric
           from jsonb_array_elements(p_edges) e
         )
         select 1
         from directed d
         left join halal_mode_private.shadow_round_edges s
           on s.run_id = p_run_id
          and s.viewer_id = d.viewer_id
          and s.subject_id = d.subject_id
         where s.run_id is null
            or s.reciprocal_score is distinct from d.score
            or s.adjusted_utility is distinct from d.utility
       ) then
      raise exception 'Shadow run output cannot be changed after it is written'
        using errcode = '22023';
    end if;

    return v_pair_count;
  end if;

  insert into halal_mode_private.shadow_round_edges (
    run_id, viewer_id, subject_id, reciprocal_score, adjusted_utility
  )
  select p_run_id, (e ->> 'a')::uuid, (e ->> 'b')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  union all
  select p_run_id, (e ->> 'b')::uuid, (e ->> 'a')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  on conflict (run_id, viewer_id, subject_id) do nothing;

  return v_pair_count;
end;
$$;

-- Client roles never receive these service methods, even if default function
-- privileges change later. Service role access is explicit and narrow.
revoke all on function public.matching_run_config() from public, anon, authenticated;
revoke all on function public.release_flag_active(text) from public, anon, authenticated;
revoke all on function public.matching_run_start(text, integer, bigint, text) from public, anon, authenticated;
revoke all on function public.matching_run_finish(uuid, integer, integer, integer, integer, jsonb, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.matching_candidate_edges_service(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.matching_member_signals_service() from public, anon, authenticated;
revoke all on function public.persist_matching_round_service(uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.matching_shadow_round_service(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.matching_run_config() to service_role;
grant execute on function public.release_flag_active(text) to service_role;
grant execute on function public.matching_run_start(text, integer, bigint, text) to service_role;
grant execute on function public.matching_run_finish(uuid, integer, integer, integer, integer, jsonb, bigint, jsonb, text) to service_role;
grant execute on function public.matching_candidate_edges_service(uuid, uuid, integer) to service_role;
grant execute on function public.matching_member_signals_service() to service_role;
grant execute on function public.persist_matching_round_service(uuid, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.matching_shadow_round_service(uuid, jsonb) to service_role;

-- These inputs are consumed inside SECURITY DEFINER functions only. RLS with
-- no policy is useful defence in depth, but an explicit table-privilege denial
-- makes the client boundary inspectable and independent of RLS behavior.
revoke all on table public.private_preferences, public.selection_scores
  from public, anon, authenticated;

-- The service reaches matching internals only through the public facade.
revoke all on function halal_mode_private.matching_candidate_edges(uuid, uuid, integer) from service_role;
revoke all on function halal_mode_private.matching_member_signals() from service_role;
revoke all on function halal_mode_private.persist_matching_round(uuid, jsonb, jsonb, timestamptz) from service_role;
