-- The first set-based prepare completed warm in 5.9 seconds, but a real cold
-- PostgREST call crossed the eight-second statement limit. Keep the relational
-- work and divide it by frozen members: each call computes up to forty men's
-- and forty women's exact top-forty sets, and retries advance from stored UUID
-- cursors. No partially prepared or partially scored edge is readable.

alter table halal_mode_private.matching_runs
  drop constraint matching_runs_candidate_snapshot_check;
alter table halal_mode_private.matching_runs
  add constraint matching_runs_candidate_snapshot_check check (
    (
      candidate_shortlist_prepared_at is null
      and candidate_snapshot_prepared_at is null
      and candidate_edge_count is null
      and (
        (
          candidate_snapshot_fail_limit is null
          and potential_edge_count is null
        ) or (
          candidate_snapshot_fail_limit > 0
          and potential_edge_count >= 0
        )
      )
    ) or (
      candidate_shortlist_prepared_at is not null
      and candidate_snapshot_fail_limit > 0
      and candidate_edge_count >= 0
      and potential_edge_count >= candidate_edge_count
    )
  );

create table halal_mode_private.matching_run_shortlist_progress (
  run_id uuid primary key
    references halal_mode_private.matching_runs(id) on delete cascade,
  male_cursor uuid,
  female_cursor uuid,
  male_complete boolean not null default false,
  female_complete boolean not null default false,
  male_processed_count integer not null default 0 check (male_processed_count >= 0),
  female_processed_count integer not null default 0 check (female_processed_count >= 0)
);

comment on table halal_mode_private.matching_run_shortlist_progress is
  'Private retry cursor for bounded set-based shortlist preparation. It is deleted when the shortlist is complete.';

revoke all on table halal_mode_private.matching_run_shortlist_progress
  from public, anon, authenticated, service_role;

create or replace function halal_mode_private.matching_shortlist_batch_edges(
  p_run_id uuid,
  p_male_ids uuid[],
  p_female_ids uuid[],
  p_evaluated_at timestamptz,
  p_max_pair_appearances integer
) returns table (
  user_low uuid,
  user_high uuid,
  pair_times_shown integer,
  pair_first_score numeric,
  pair_last_score numeric,
  cooldown_until timestamptz,
  retired_at timestamptz,
  explicit_pass_count smallint,
  soft_select_count smallint
)
language sql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private
set work_mem = '24MB' as $$
  with
  current_members as materialized (
    select
      snapshot.*,
      lower(btrim(snapshot.country)) as country_key,
      coalesce((
        select array_agg(lower(btrim(allowed.country)))
        from unnest(coalesce(snapshot.preferred_countries, '{}'::text[]))
          as allowed(country)
      ), '{}'::text[]) as preferred_country_keys,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'age') = 'boolean'
        then (snapshot.must_have ->> 'age')::boolean else false end as must_age,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'height') = 'boolean'
        then (snapshot.must_have ->> 'height')::boolean else false end as must_height,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'build') = 'boolean'
        then (snapshot.must_have ->> 'build')::boolean else false end as must_build,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'practice') = 'boolean'
        then (snapshot.must_have ->> 'practice')::boolean else false end as must_practice,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'timeline') = 'boolean'
        then (snapshot.must_have ->> 'timeline')::boolean else false end as must_timeline,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'children') = 'boolean'
        then (snapshot.must_have ->> 'children')::boolean else false end as must_children,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'sect') = 'boolean'
        then (snapshot.must_have ->> 'sect')::boolean else false end as must_sect,
      case when jsonb_typeof(coalesce(snapshot.must_have, '{}'::jsonb) -> 'distance') = 'boolean'
        then (snapshot.must_have ->> 'distance')::boolean else false end as must_distance
    from halal_mode_private.matching_run_member_snapshots snapshot
    where snapshot.run_id = p_run_id
  ),
  country_pairs as materialized (
    select
      male.user_id as male_id,
      female.user_id as female_id,
      male.user_id = any(coalesce(p_male_ids, '{}'::uuid[])) as male_in_batch,
      female.user_id = any(coalesce(p_female_ids, '{}'::uuid[])) as female_in_batch,
      least(male.user_id, female.user_id) as user_low,
      greatest(male.user_id, female.user_id) as user_high,
      male.country_key = female.country_key as same_country,
      male.latitude is not null and male.longitude is not null
        and female.latitude is not null and female.longitude is not null
        as coordinates_available,
      case
        when male.country_key = female.country_key
         and (male.must_distance or female.must_distance)
         and male.latitude is not null and male.longitude is not null
         and female.latitude is not null and female.longitude is not null then
          6371 * acos(least(1, greatest(-1,
            cos(radians(male.latitude)) * cos(radians(female.latitude))
              * cos(radians(female.longitude) - radians(male.longitude))
            + sin(radians(male.latitude)) * sin(radians(female.latitude))
          )))
        else null
      end as distance_km,
      coalesce(abs(male.age - female.age), 0)::double precision
        + coalesce(
            sqrt(
              power((female.latitude - male.latitude) * 111.0, 2)
              + power((female.longitude - male.longitude) * 111.0
                  * cos(radians((male.latitude + female.latitude) / 2)), 2)
            ) / 100.0,
            0
          ) as apartness
    from current_members male
    join current_members female on female.gender = 'female'
    where male.gender = 'male'
      and (
        male.user_id = any(coalesce(p_male_ids, '{}'::uuid[]))
        or female.user_id = any(coalesce(p_female_ids, '{}'::uuid[]))
      )
      and (
        male.country_key = female.country_key
        or (male.relocation in ('open', 'willing_abroad')
          and (cardinality(male.preferred_country_keys) = 0
            or female.country_key = any(male.preferred_country_keys)))
      )
      and (
        female.country_key = male.country_key
        or (female.relocation in ('open', 'willing_abroad')
          and (cardinality(female.preferred_country_keys) = 0
            or male.country_key = any(female.preferred_country_keys)))
      )
  ),
  eligible_pairs as materialized (
    select
      pair.*,
      coalesce(exposure.times_shown, 0) as pair_times_shown,
      exposure.first_reciprocal_score as pair_first_score,
      exposure.last_reciprocal_score as pair_last_score,
      exposure.cooldown_until,
      exposure.retired_at,
      coalesce(exposure.explicit_pass_count, 0)::smallint as explicit_pass_count,
      coalesce(exposure.soft_select_count, 0)::smallint as soft_select_count
    from country_pairs pair
    join current_members male on male.user_id = pair.male_id
    join current_members female on female.user_id = pair.female_id
    left join halal_mode_private.pair_exposure exposure
      on exposure.user_low = pair.user_low and exposure.user_high = pair.user_high
    where (not male.must_age or female.age between male.min_age and male.max_age)
      and (not female.must_age or male.age between female.min_age and female.max_age)
      and (not male.must_height or female.own_height_cm is null
        or female.own_height_cm between male.min_height_cm and male.max_height_cm)
      and (not female.must_height or male.own_height_cm is null
        or male.own_height_cm between female.min_height_cm and female.max_height_cm)
      and (not male.must_build or cardinality(male.preferred_builds) = 0
        or female.own_build is null or female.own_build = any(male.preferred_builds))
      and (not female.must_build or cardinality(female.preferred_builds) = 0
        or male.own_build is null or male.own_build = any(female.preferred_builds))
      and (not male.must_practice or cardinality(male.preferred_practice) = 0
        or female.religious_practice = any(male.preferred_practice))
      and (not female.must_practice or cardinality(female.preferred_practice) = 0
        or male.religious_practice = any(female.preferred_practice))
      and (not male.must_timeline or cardinality(male.desired_timeline) = 0
        or female.timeline = any(male.desired_timeline))
      and (not female.must_timeline or cardinality(female.desired_timeline) = 0
        or male.timeline = any(female.desired_timeline))
      and (not male.must_children or cardinality(male.desired_family_goals) = 0
        or female.family_goals = any(male.desired_family_goals))
      and (not female.must_children or cardinality(female.desired_family_goals) = 0
        or male.family_goals = any(female.desired_family_goals))
      and (not male.must_sect or cardinality(male.preferred_sects) = 0
        or female.sect = 'prefer_not_to_say' or female.sect = any(male.preferred_sects))
      and (not female.must_sect or cardinality(female.preferred_sects) = 0
        or male.sect = 'prefer_not_to_say' or male.sect = any(female.preferred_sects))
      and (not pair.same_country or (
        pair.coordinates_available
        and (not male.must_distance or pair.distance_km <= male.max_distance_km)
        and (not female.must_distance or pair.distance_km <= female.max_distance_km)
      ))
      and not exists (
        select 1 from public.connections connection
        where connection.user_a = pair.user_low and connection.user_b = pair.user_high
      )
      and not exists (
        select 1 from public.blocks block
        where block.blocker_id = pair.male_id and block.blocked_id = pair.female_id
      )
      and not exists (
        select 1 from public.blocks block
        where block.blocker_id = pair.female_id and block.blocked_id = pair.male_id
      )
      and not exists (
        select 1 from halal_mode_private.member_hides hidden
        where hidden.hider_id = pair.male_id and hidden.hidden_id = pair.female_id
      )
      and not exists (
        select 1 from halal_mode_private.member_hides hidden
        where hidden.hider_id = pair.female_id and hidden.hidden_id = pair.male_id
      )
      and not exists (
        select 1 from public.introduction_selections selection
        where selection.decision = 'explicit_pass'
          and selection.viewer_id = pair.male_id
          and selection.subject_id = pair.female_id
      )
      and not exists (
        select 1 from public.introduction_selections selection
        where selection.decision = 'explicit_pass'
          and selection.viewer_id = pair.female_id
          and selection.subject_id = pair.male_id
      )
      and exposure.retired_at is null
      and coalesce(exposure.times_shown, 0) < p_max_pair_appearances
      and (exposure.cooldown_until is null or exposure.cooldown_until <= p_evaluated_at)
  ),
  ranked_pairs as (
    select
      eligible.*,
      row_number() over (
        partition by eligible.male_id
        order by eligible.apartness, eligible.female_id
      ) as his_rank,
      row_number() over (
        partition by eligible.female_id
        order by eligible.apartness, eligible.male_id
      ) as her_rank
    from eligible_pairs eligible
  )
  select
    ranked.user_low,
    ranked.user_high,
    ranked.pair_times_shown,
    ranked.pair_first_score,
    ranked.pair_last_score,
    ranked.cooldown_until,
    ranked.retired_at,
    ranked.explicit_pass_count,
    ranked.soft_select_count
  from ranked_pairs ranked
  where (ranked.male_in_batch and ranked.his_rank <= 40)
     or (ranked.female_in_batch and ranked.her_rank <= 40);
$$;

revoke all on function halal_mode_private.matching_shortlist_batch_edges(
  uuid, uuid[], uuid[], timestamptz, integer
) from public, anon, authenticated, service_role;

create or replace function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(
  p_run_id uuid,
  p_fail_limit bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set work_mem = '24MB' as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_progress halal_mode_private.matching_run_shortlist_progress%rowtype;
  v_config jsonb;
  v_male_count bigint;
  v_female_count bigint;
  v_potential_edge_count bigint;
  v_candidate_edge_count bigint;
  v_max_pair_appearances integer;
  v_lock_deadline timestamptz;
  v_male_ids uuid[] := '{}'::uuid[];
  v_female_ids uuid[] := '{}'::uuid[];
  v_male_batch_count integer := 0;
  v_female_batch_count integer := 0;
  v_male_cursor uuid;
  v_female_cursor uuid;
  v_male_complete boolean;
  v_female_complete boolean;
  v_members_processed integer;
  v_shortlist_complete boolean;
  v_scoring_complete boolean := false;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching snapshot preparation requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_fail_limit is null or p_fail_limit < 1 then
    raise exception 'A run id and positive candidate fail limit are required'
      using errcode = '22023';
  end if;

  v_lock_deadline := clock_timestamp() + interval '5 seconds';
  perform halal_mode_private.take_matching_lock(
    p_run_id::text, 5701, v_lock_deadline
  );

  select * into v_run
  from halal_mode_private.matching_runs
  where id = p_run_id
  for update;

  if v_run.id is null or v_run.cycle_date is null then
    raise exception 'A snapshot-capable matching run is required'
      using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'A finished matching run cannot prepare candidates'
      using errcode = '22023';
  end if;

  select config.params into v_config
  from halal_mode_private.matching_config config
  where config.version = v_run.config_version;
  if v_config is null then
    raise exception 'The matching run has no configuration'
      using errcode = '22023';
  end if;
  v_max_pair_appearances := (v_config ->> 'max_pair_appearances')::integer;
  if v_max_pair_appearances is null or v_max_pair_appearances < 1 then
    raise exception 'The matching run has no valid pair appearance limit'
      using errcode = '22023';
  end if;

  if v_run.candidate_shortlist_prepared_at is not null then
    if v_run.candidate_snapshot_fail_limit is distinct from p_fail_limit then
      raise exception 'A prepared matching snapshot cannot change its fail limit'
        using errcode = '40001';
    end if;
    if ((
      select count(*)::bigint
      from halal_mode_private.matching_run_candidate_shortlists shortlist
      where shortlist.run_id = p_run_id
    ) is distinct from (case
      when v_run.candidate_snapshot_prepared_at is null
        then v_run.candidate_edge_count else 0 end))
    or ((
      select count(*)::bigint
      from halal_mode_private.matching_run_candidate_snapshots candidate
      where candidate.run_id = p_run_id
    ) is distinct from (case
      when v_run.candidate_snapshot_prepared_at is null
        then 0 else v_run.candidate_edge_count end)) then
      raise exception 'The prepared matching shortlist is inconsistent'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'candidate_edge_count', v_run.candidate_edge_count,
      'potential_edge_count', v_run.potential_edge_count,
      'shortlist_complete', true,
      'shortlist_members_processed', v_run.pool_member_count,
      'scoring_complete', v_run.candidate_snapshot_prepared_at is not null
    );
  end if;

  select * into v_progress
  from halal_mode_private.matching_run_shortlist_progress progress
  where progress.run_id = p_run_id
  for update;

  if not found then
    if exists (
      select 1 from halal_mode_private.matching_run_candidate_shortlists shortlist
      where shortlist.run_id = p_run_id
    ) or exists (
      select 1 from halal_mode_private.matching_run_candidate_snapshots candidate
      where candidate.run_id = p_run_id
    ) then
      raise exception 'Uncommitted candidate rows conflict with run state'
        using errcode = '55000';
    end if;
    if (select count(*)::integer
        from halal_mode_private.matching_run_member_snapshots member
        where member.run_id = p_run_id) is distinct from v_run.pool_member_count then
      raise exception 'The matching member snapshot is inconsistent'
        using errcode = '55000';
    end if;

    select
      count(*) filter (where gender = 'male')::bigint,
      count(*) filter (where gender = 'female')::bigint
    into v_male_count, v_female_count
    from halal_mode_private.matching_run_member_snapshots
    where run_id = p_run_id;
    v_potential_edge_count := v_male_count * v_female_count;

    if v_potential_edge_count > p_fail_limit then
      raise exception 'Potential candidate edge count % exceeds fail limit %',
        v_potential_edge_count, p_fail_limit
        using errcode = '54000';
    end if;

    insert into halal_mode_private.matching_run_shortlist_progress(run_id)
    values (p_run_id)
    returning * into v_progress;

    update halal_mode_private.matching_runs
    set candidate_snapshot_fail_limit = p_fail_limit,
        potential_edge_count = v_potential_edge_count
    where id = p_run_id;
  else
    if v_run.candidate_snapshot_fail_limit is distinct from p_fail_limit then
      raise exception 'A preparing matching snapshot cannot change its fail limit'
        using errcode = '40001';
    end if;
    v_potential_edge_count := v_run.potential_edge_count;
  end if;

  if not v_progress.male_complete then
    select coalesce(array_agg(next_member.user_id order by next_member.user_id), '{}'::uuid[])
    into v_male_ids
    from (
      select member.user_id
      from halal_mode_private.matching_run_member_snapshots member
      where member.run_id = p_run_id
        and member.gender = 'male'
        and (v_progress.male_cursor is null or member.user_id > v_progress.male_cursor)
      order by member.user_id
      limit 40
    ) next_member;
  end if;
  if not v_progress.female_complete then
    select coalesce(array_agg(next_member.user_id order by next_member.user_id), '{}'::uuid[])
    into v_female_ids
    from (
      select member.user_id
      from halal_mode_private.matching_run_member_snapshots member
      where member.run_id = p_run_id
        and member.gender = 'female'
        and (v_progress.female_cursor is null or member.user_id > v_progress.female_cursor)
      order by member.user_id
      limit 40
    ) next_member;
  end if;

  v_male_batch_count := coalesce(cardinality(v_male_ids), 0);
  v_female_batch_count := coalesce(cardinality(v_female_ids), 0);
  v_male_cursor := case when v_male_batch_count > 0
    then v_male_ids[v_male_batch_count] else v_progress.male_cursor end;
  v_female_cursor := case when v_female_batch_count > 0
    then v_female_ids[v_female_batch_count] else v_progress.female_cursor end;

  insert into halal_mode_private.matching_run_candidate_shortlists (
    run_id, user_low, user_high,
    pair_times_shown, pair_first_score, pair_last_score,
    cooldown_until, retired_at, explicit_pass_count, soft_select_count
  )
  select
    p_run_id,
    edge.user_low,
    edge.user_high,
    edge.pair_times_shown,
    edge.pair_first_score,
    edge.pair_last_score,
    edge.cooldown_until,
    edge.retired_at,
    edge.explicit_pass_count,
    edge.soft_select_count
  from halal_mode_private.matching_shortlist_batch_edges(
    p_run_id,
    v_male_ids,
    v_female_ids,
    v_run.evaluated_at,
    v_max_pair_appearances
  ) edge
  on conflict (run_id, user_low, user_high) do nothing;

  v_male_complete := v_progress.male_complete or not exists (
    select 1
    from halal_mode_private.matching_run_member_snapshots member
    where member.run_id = p_run_id and member.gender = 'male'
      and (v_male_cursor is null or member.user_id > v_male_cursor)
  );
  v_female_complete := v_progress.female_complete or not exists (
    select 1
    from halal_mode_private.matching_run_member_snapshots member
    where member.run_id = p_run_id and member.gender = 'female'
      and (v_female_cursor is null or member.user_id > v_female_cursor)
  );
  v_shortlist_complete := v_male_complete and v_female_complete;

  update halal_mode_private.matching_run_shortlist_progress
  set male_cursor = v_male_cursor,
      female_cursor = v_female_cursor,
      male_complete = v_male_complete,
      female_complete = v_female_complete,
      male_processed_count = male_processed_count + v_male_batch_count,
      female_processed_count = female_processed_count + v_female_batch_count
  where run_id = p_run_id
  returning male_processed_count + female_processed_count
  into v_members_processed;

  select count(*)::bigint into v_candidate_edge_count
  from halal_mode_private.matching_run_candidate_shortlists shortlist
  where shortlist.run_id = p_run_id;

  if v_shortlist_complete then
    update halal_mode_private.matching_runs
    set candidate_shortlist_prepared_at = clock_timestamp(),
        candidate_edge_count = v_candidate_edge_count
    where id = p_run_id;

    delete from halal_mode_private.matching_run_shortlist_progress progress
    where progress.run_id = p_run_id;

    if v_candidate_edge_count = 0 then
      update halal_mode_private.matching_runs
      set candidate_snapshot_prepared_at = clock_timestamp()
      where id = p_run_id;
      v_scoring_complete := true;
    elsif v_candidate_edge_count <= 500 then
      perform public.matching_candidate_snapshot_score_batch_service(
        p_run_id, v_candidate_edge_count::integer
      );
      v_scoring_complete := true;
    end if;
  end if;

  return jsonb_build_object(
    'candidate_edge_count', v_candidate_edge_count,
    'potential_edge_count', v_potential_edge_count,
    'shortlist_complete', v_shortlist_complete,
    'shortlist_members_processed', v_members_processed,
    'scoring_complete', v_scoring_complete
  );
end;
$$;

revoke all on function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid, bigint)
  from public, anon, authenticated, service_role;

comment on function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid, bigint) is
  'Advances a frozen reciprocal shortlist by at most forty members of each gender using one set operation; retries resume from private UUID cursors.';

do $$
declare
  definition text := pg_get_functiondef(
      'halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid,bigint)'::regprocedure
    ) || pg_get_functiondef(
      'halal_mode_private.matching_shortlist_batch_edges(uuid,uuid[],uuid[],timestamptz,integer)'::regprocedure
    ) || pg_get_functiondef(
      'public.matching_candidate_snapshot_score_batch_service(uuid,integer)'::regprocedure
    );
  forbidden text;
begin
  foreach forbidden in array array[
    'compatibility(',
    'matching_pair_is_eligible(',
    'snapshot_pair_is_plausible(',
    'pair_apartness(',
    'passes_criteria(',
    'is_must_have(',
    'distance_km(',
    'scale_proximity(',
    'pg_advisory_xact_lock('
  ] loop
    if strpos(definition, forbidden) > 0 then
      raise exception 'Set-based matcher contains forbidden row-at-a-time call: %', forbidden;
    end if;
  end loop;
end;
$$;
