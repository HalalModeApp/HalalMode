-- Build one candidate set from one frozen member set.
--
-- 0138 reduced the number of pairs, but the surviving pairs still called
-- compatibility() twice and matching_pair_is_eligible() once. Those functions
-- re-read the same profile and preference rows for every pair, turning 34,575
-- cheap comparisons into hundreds of thousands of index lookups. This
-- migration freezes the remaining score inputs and performs eligibility,
-- shortlisting, and both directional scores as relational operations.
--
-- The retained candidate set is bounded by the union of each member's forty
-- nearest plausible counterparts. No client role can read either snapshot.

alter table halal_mode_private.matching_run_member_snapshots
  add column if not exists min_height_cm integer,
  add column if not exists max_height_cm integer,
  add column if not exists preferred_builds text[],
  add column if not exists preferred_practice public.religious_practice[],
  add column if not exists desired_timeline public.marriage_timeline[],
  add column if not exists desired_family_goals public.family_goals[],
  add column if not exists preferred_sects public.sect[],
  add column if not exists own_height_cm integer,
  add column if not exists own_build text,
  add column if not exists religious_practice public.religious_practice,
  add column if not exists timeline public.marriage_timeline,
  add column if not exists family_goals public.family_goals,
  add column if not exists sect public.sect,
  add column if not exists languages_spoken text[];

alter table halal_mode_private.matching_runs
  add column if not exists candidate_shortlist_prepared_at timestamptz;

update halal_mode_private.matching_runs
set candidate_shortlist_prepared_at = candidate_snapshot_prepared_at
where candidate_shortlist_prepared_at is null
  and candidate_snapshot_prepared_at is not null;

alter table halal_mode_private.matching_runs
  drop constraint matching_runs_candidate_snapshot_check;
alter table halal_mode_private.matching_runs
  add constraint matching_runs_candidate_snapshot_check check (
    (
      candidate_shortlist_prepared_at is null
      and candidate_snapshot_prepared_at is null
      and candidate_snapshot_fail_limit is null
      and candidate_edge_count is null
      and potential_edge_count is null
    ) or (
      candidate_shortlist_prepared_at is not null
      and candidate_snapshot_fail_limit > 0
      and candidate_edge_count >= 0
      and potential_edge_count >= candidate_edge_count
    )
  );

create table halal_mode_private.matching_run_candidate_shortlists (
  run_id uuid not null references halal_mode_private.matching_runs(id) on delete cascade,
  user_low uuid not null,
  user_high uuid not null,
  pair_times_shown integer not null,
  pair_first_score numeric,
  pair_last_score numeric,
  cooldown_until timestamptz,
  retired_at timestamptz,
  explicit_pass_count smallint not null default 0,
  soft_select_count smallint not null default 0,
  primary key (run_id, user_low, user_high),
  check (user_low < user_high)
);

comment on table halal_mode_private.matching_run_candidate_shortlists is
  'Private, frozen shortlist staging. It deliberately has no per-member foreign keys; bounded score batches copy only complete rows into the authoritative candidate snapshot.';

revoke all on table halal_mode_private.matching_run_candidate_shortlists
  from public, anon, authenticated, service_role;

create index if not exists matching_run_member_snapshots_run_gender_user_idx
  on halal_mode_private.matching_run_member_snapshots (run_id, gender, user_id);

create index if not exists introduction_selections_explicit_pair_idx
  on public.introduction_selections (viewer_id, subject_id)
  where decision = 'explicit_pass';

-- A run started immediately before this migration has not frozen the new
-- columns. Repair only unfinished, unprepared runs; historical snapshots stay
-- immutable.
update halal_mode_private.matching_run_member_snapshots snapshot
set min_height_cm = preferences.min_height_cm,
    max_height_cm = preferences.max_height_cm,
    preferred_builds = preferences.preferred_builds,
    preferred_practice = preferences.preferred_practice,
    desired_timeline = preferences.desired_timeline,
    desired_family_goals = preferences.desired_family_goals,
    preferred_sects = preferences.preferred_sects,
    own_height_cm = preferences.own_height_cm,
    own_build = preferences.own_build,
    religious_practice = profile.religious_practice,
    timeline = profile.timeline,
    family_goals = profile.family_goals,
    sect = profile.sect,
    languages_spoken = profile.languages_spoken
from halal_mode_private.matching_runs run,
     public.profiles profile,
     public.private_preferences preferences
where run.id = snapshot.run_id
  and run.finished_at is null
  and run.candidate_snapshot_prepared_at is null
  and profile.id = snapshot.user_id
  and preferences.user_id = snapshot.user_id;

create or replace function public.matching_run_start_service(
  p_algorithm_version text,
  p_config_version integer,
  p_seed bigint,
  p_mode text,
  p_cycle_date date,
  p_evaluated_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
declare
  v_run_id uuid;
  v_window_days integer;
  v_window_offset integer;
  v_window_starts_on date;
  v_window_ends_on date;
  v_pool_member_count integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching run creation requires service role'
      using errcode = '42501';
  end if;
  if nullif(btrim(p_algorithm_version), '') is null
     or length(p_algorithm_version) > 100
     or p_seed is null
     or p_cycle_date is null
     or p_evaluated_at is null then
    raise exception 'A complete matching run context is required'
      using errcode = '22023';
  end if;
  if (p_evaluated_at at time zone 'Asia/Riyadh')::date is distinct from p_cycle_date then
    raise exception 'Matching evaluation time must fall on the cycle date in Riyadh'
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

  select (params ->> 'exposure_window_rounds')::integer
  into v_window_days
  from halal_mode_private.matching_config
  where version = p_config_version;
  if v_window_days is null or v_window_days < 1 then
    raise exception 'Matching exposure window configuration is invalid'
      using errcode = '22023';
  end if;

  v_window_offset := mod(p_cycle_date - date '1970-01-01', v_window_days);
  if v_window_offset < 0 then
    v_window_offset := v_window_offset + v_window_days;
  end if;
  v_window_starts_on := p_cycle_date - v_window_offset;
  v_window_ends_on := v_window_starts_on + (v_window_days - 1);

  insert into halal_mode_private.matching_runs (
    algorithm_version, config_version, seed, mode, cycle_date, time_zone,
    window_starts_on, window_ends_on, rounds_elapsed_in_window,
    evaluated_at, pool_member_count
  ) values (
    btrim(p_algorithm_version), p_config_version, p_seed, p_mode,
    p_cycle_date, 'Asia/Riyadh', v_window_starts_on, v_window_ends_on,
    v_window_offset + 1, p_evaluated_at, 0
  ) returning id into v_run_id;

  insert into halal_mode_private.matching_run_member_snapshots (
    run_id, user_id, gender, tier, times_shown, times_kept,
    rounds_since_last_mutual, rounds_since_last_served,
    exposures_in_window, introductions_per_round,
    country, relocation, latitude, longitude, age,
    min_age, max_age, max_distance_km, preferred_countries, must_have,
    min_height_cm, max_height_cm, preferred_builds, preferred_practice,
    desired_timeline, desired_family_goals, preferred_sects,
    own_height_cm, own_build, religious_practice, timeline, family_goals,
    sect, languages_spoken
  )
  select
    v_run_id,
    pool.id,
    pool.gender,
    pool.tier,
    pool.qualified_exposures::integer,
    pool.times_picked_by_others::integer,
    pool.rounds_since_last_mutual::integer,
    pool.rounds_since_last_served::integer,
    (
      select count(*)::integer
      from public.introductions introduction
      join public.rounds round on round.id = introduction.round_id
      where introduction.viewer_id = pool.id
        and (round.opens_at at time zone 'Asia/Riyadh')::date
          between v_window_starts_on and p_cycle_date
    ),
    pool.introductions_per_round::integer,
    pool.country,
    pool.relocation::text,
    pool.latitude,
    pool.longitude,
    pool.age,
    pool.min_age,
    pool.max_age,
    pool.max_distance_km,
    pool.preferred_countries,
    pool.must_have,
    preferences.min_height_cm,
    preferences.max_height_cm,
    preferences.preferred_builds,
    preferences.preferred_practice,
    preferences.desired_timeline,
    preferences.desired_family_goals,
    preferences.preferred_sects,
    preferences.own_height_cm,
    preferences.own_build,
    profile.religious_practice,
    profile.timeline,
    profile.family_goals,
    profile.sect,
    profile.languages_spoken
  from halal_mode_private.matching_pool pool
  join public.profiles profile on profile.id = pool.id
  join public.private_preferences preferences on preferences.user_id = pool.id;
  get diagnostics v_pool_member_count = row_count;

  update halal_mode_private.matching_runs
  set pool_member_count = v_pool_member_count
  where id = v_run_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'seed', p_seed,
    'cycle_date', p_cycle_date,
    'time_zone', 'Asia/Riyadh',
    'window_starts_on', v_window_starts_on,
    'window_ends_on', v_window_ends_on,
    'rounds_elapsed_in_window', v_window_offset + 1,
    'evaluated_at', p_evaluated_at,
    'pool_member_count', v_pool_member_count
  );
end;
$$;

create or replace function public.matching_candidate_snapshot_score_batch_service(
  p_run_id uuid,
  p_batch_size integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set work_mem = '16MB' as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_config jsonb;
  v_scored_rows integer;
  v_remaining_rows bigint;
  v_total_rows bigint;
  v_lock_deadline timestamptz;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Matching snapshot scoring requires service role'
      using errcode = '42501';
  end if;
  if p_run_id is null or p_batch_size is null
     or p_batch_size < 1 or p_batch_size > 500 then
    raise exception 'A run id and score batch size from 1 to 500 are required'
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

  if v_run.id is null or v_run.candidate_shortlist_prepared_at is null then
    raise exception 'Prepare the matching shortlist before scoring it'
      using errcode = '55000';
  end if;
  if v_run.finished_at is not null then
    raise exception 'A finished matching run cannot score candidates'
      using errcode = '22023';
  end if;
  if v_run.candidate_snapshot_prepared_at is not null then
    return jsonb_build_object(
      'scored_rows', 0,
      'remaining_rows', 0,
      'complete', true
    );
  end if;

  select config.params into v_config
  from halal_mode_private.matching_config config
  where config.version = v_run.config_version;
  if v_config is null then
    raise exception 'The matching run has no configuration'
      using errcode = '22023';
  end if;

  with
  score_config as materialized (
    select
      coalesce((v_config -> 'weights' ->> 'age')::numeric, 0) as w_age,
      coalesce((v_config -> 'weights' ->> 'height')::numeric, 0) as w_height,
      coalesce((v_config -> 'weights' ->> 'build')::numeric, 0) as w_build,
      coalesce((v_config -> 'weights' ->> 'practice')::numeric, 0) as w_practice,
      coalesce((v_config -> 'weights' ->> 'timeline')::numeric, 0) as w_timeline,
      coalesce((v_config -> 'weights' ->> 'children')::numeric, 0) as w_children,
      coalesce((v_config -> 'weights' ->> 'relocation')::numeric, 0) as w_relocation,
      coalesce((v_config -> 'weights' ->> 'distance')::numeric, 0) as w_distance,
      coalesce((v_config -> 'weights' ->> 'languages')::numeric, 0) as w_languages,
      coalesce((v_config -> 'falloff' ->> 'build')::numeric, 0.88) as f_build,
      coalesce((v_config -> 'falloff' ->> 'practice')::numeric, 0.70) as f_practice,
      coalesce((v_config -> 'falloff' ->> 'timeline')::numeric, 0.85) as f_timeline,
      coalesce((v_config -> 'falloff' ->> 'children')::numeric, 0.65) as f_children,
      coalesce((v_config -> 'falloff' ->> 'relocation')::numeric, 0.80) as f_relocation,
      coalesce((v_config ->> 'distance_free_km')::numeric, 25) as distance_free_km,
      coalesce((v_config ->> 'sect_mismatch_score')::numeric, 0.15) as sect_mismatch_score
  ),
  batch_pairs as materialized (
    select shortlist.*
    from halal_mode_private.matching_run_candidate_shortlists shortlist
    where shortlist.run_id = p_run_id
      and not exists (
        select 1
        from halal_mode_private.matching_run_candidate_snapshots candidate
        where candidate.run_id = shortlist.run_id
          and candidate.user_low = shortlist.user_low
          and candidate.user_high = shortlist.user_high
      )
    order by shortlist.user_low, shortlist.user_high
    limit p_batch_size
  ),
  members as materialized (
    select
      snapshot.*,
      build_lookup.values_by_position as build_fit_by_position,
      practice_lookup.values_by_position as practice_fit_by_position,
      timeline_lookup.values_by_position as timeline_fit_by_position,
      children_lookup.values_by_position as children_fit_by_position,
      own_build_scale.position as own_build_position,
      practice_scale.position as practice_position,
      timeline_scale.position as timeline_position,
      children_scale.position as children_position,
      relocation_scale.position as relocation_position
    from halal_mode_private.matching_run_member_snapshots snapshot
    cross join score_config config
    left join halal_mode_private.criterion_scale own_build_scale
      on own_build_scale.criterion = 'build'
     and own_build_scale.value = snapshot.own_build
    left join halal_mode_private.criterion_scale practice_scale
      on practice_scale.criterion = 'practice'
     and practice_scale.value = snapshot.religious_practice::text
    left join halal_mode_private.criterion_scale timeline_scale
      on timeline_scale.criterion = 'timeline'
     and timeline_scale.value = snapshot.timeline::text
    left join halal_mode_private.criterion_scale children_scale
      on children_scale.criterion = 'children'
     and children_scale.value = snapshot.family_goals::text
    left join halal_mode_private.criterion_scale relocation_scale
      on relocation_scale.criterion = 'relocation'
     and relocation_scale.value = snapshot.relocation
    left join lateral (
      select array_agg(fit.term order by fit.position) as values_by_position
      from (
        select subject.position,
          max(coalesce(power(
            greatest(0.01, least(1.0, config.f_build)),
            abs(wanted.position - subject.position)
          ), 1.0)) as term
        from halal_mode_private.criterion_scale subject
        left join lateral unnest(coalesce(snapshot.preferred_builds, '{}'::text[]))
          desired(value) on true
        left join halal_mode_private.criterion_scale wanted
          on wanted.criterion = 'build' and wanted.value = desired.value
        where subject.criterion = 'build'
        group by subject.position
      ) fit
    ) build_lookup on true
    left join lateral (
      select array_agg(fit.term order by fit.position) as values_by_position
      from (
        select subject.position,
          max(coalesce(power(
            greatest(0.01, least(1.0, config.f_practice)),
            abs(wanted.position - subject.position)
          ), 1.0)) as term
        from halal_mode_private.criterion_scale subject
        left join lateral unnest(coalesce(snapshot.preferred_practice,
          '{}'::public.religious_practice[])) desired(value) on true
        left join halal_mode_private.criterion_scale wanted
          on wanted.criterion = 'practice' and wanted.value = desired.value::text
        where subject.criterion = 'practice'
        group by subject.position
      ) fit
    ) practice_lookup on true
    left join lateral (
      select array_agg(fit.term order by fit.position) as values_by_position
      from (
        select subject.position,
          max(coalesce(power(
            greatest(0.01, least(1.0, config.f_timeline)),
            abs(wanted.position - subject.position)
          ), 1.0)) as term
        from halal_mode_private.criterion_scale subject
        left join lateral unnest(coalesce(snapshot.desired_timeline,
          '{}'::public.marriage_timeline[])) desired(value) on true
        left join halal_mode_private.criterion_scale wanted
          on wanted.criterion = 'timeline' and wanted.value = desired.value::text
        where subject.criterion = 'timeline'
        group by subject.position
      ) fit
    ) timeline_lookup on true
    left join lateral (
      select array_agg(fit.term order by fit.position) as values_by_position
      from (
        select subject.position,
          max(coalesce(power(
            greatest(0.01, least(1.0, config.f_children)),
            abs(wanted.position - subject.position)
          ), 1.0)) as term
        from halal_mode_private.criterion_scale subject
        left join lateral unnest(coalesce(snapshot.desired_family_goals,
          '{}'::public.family_goals[])) desired(value) on true
        left join halal_mode_private.criterion_scale wanted
          on wanted.criterion = 'children' and wanted.value = desired.value::text
        where subject.criterion = 'children'
        group by subject.position
      ) fit
    ) children_lookup on true
    where snapshot.run_id = p_run_id
      and exists (
        select 1
        from batch_pairs pair
        where snapshot.user_id in (pair.user_low, pair.user_high)
      )
  ),
  pair_metrics as materialized (
    select
      pair.user_low,
      pair.user_high,
      lower(btrim(low.country)) = lower(btrim(high.country)) as same_country,
      case
        when low.latitude is not null and low.longitude is not null
         and high.latitude is not null and high.longitude is not null then
          6371 * acos(least(1, greatest(-1,
            cos(radians(low.latitude)) * cos(radians(high.latitude))
              * cos(radians(high.longitude) - radians(low.longitude))
            + sin(radians(low.latitude)) * sin(radians(high.latitude))
          )))
        else null
      end as distance_km
    from batch_pairs pair
    join members low on low.user_id = pair.user_low
    join members high on high.user_id = pair.user_high
  ),
  directions as (
    select
      pair.user_low, pair.user_high,
      low.user_id as viewer_id,
      high.age as subject_age,
      low.min_age, low.max_age, low.max_distance_km,
      low.min_height_cm, low.max_height_cm,
      low.preferred_builds, low.preferred_practice,
      low.desired_timeline, low.desired_family_goals, low.preferred_sects,
      low.build_fit_by_position, low.practice_fit_by_position,
      low.timeline_fit_by_position, low.children_fit_by_position,
      low.relocation_position as viewer_relocation_position,
      low.languages_spoken as viewer_languages,
      high.own_height_cm as subject_height_cm,
      high.own_build is not null as subject_build_present,
      high.own_build_position as subject_build_position,
      high.practice_position as subject_practice_position,
      high.timeline_position as subject_timeline_position,
      high.children_position as subject_children_position,
      high.relocation_position as subject_relocation_position,
      high.sect as subject_sect,
      high.languages_spoken as subject_languages,
      pair.same_country, pair.distance_km
    from pair_metrics pair
    join members low on low.user_id = pair.user_low
    join members high on high.user_id = pair.user_high
    union all
    select
      pair.user_low, pair.user_high,
      high.user_id as viewer_id,
      low.age as subject_age,
      high.min_age, high.max_age, high.max_distance_km,
      high.min_height_cm, high.max_height_cm,
      high.preferred_builds, high.preferred_practice,
      high.desired_timeline, high.desired_family_goals, high.preferred_sects,
      high.build_fit_by_position, high.practice_fit_by_position,
      high.timeline_fit_by_position, high.children_fit_by_position,
      high.relocation_position as viewer_relocation_position,
      high.languages_spoken as viewer_languages,
      low.own_height_cm as subject_height_cm,
      low.own_build is not null as subject_build_present,
      low.own_build_position as subject_build_position,
      low.practice_position as subject_practice_position,
      low.timeline_position as subject_timeline_position,
      low.children_position as subject_children_position,
      low.relocation_position as subject_relocation_position,
      low.sect as subject_sect,
      low.languages_spoken as subject_languages,
      pair.same_country, pair.distance_km
    from pair_metrics pair
    join members low on low.user_id = pair.user_low
    join members high on high.user_id = pair.user_high
  ),
  directional_terms as (
    select
      direction.*,
      config.*,
      case
        when direction.subject_age between direction.min_age and direction.max_age
          then 1.0::numeric
        else greatest(0.0::numeric, 1.0 - (
          case when direction.subject_age < direction.min_age
            then direction.min_age - direction.subject_age
            else direction.subject_age - direction.max_age end
        )::numeric / greatest(1, direction.max_age - direction.min_age))
      end as age_term,
      case
        when direction.subject_height_cm is null then null
        when direction.subject_height_cm between direction.min_height_cm
             and direction.max_height_cm then 1.0::numeric
        else greatest(0.0::numeric, 1.0 - (
          case when direction.subject_height_cm < direction.min_height_cm
            then direction.min_height_cm - direction.subject_height_cm
            else direction.subject_height_cm - direction.max_height_cm end
        )::numeric / greatest(1, direction.max_height_cm - direction.min_height_cm))
      end as height_term,
      case when cardinality(direction.preferred_builds) > 0
          and direction.subject_build_present
        then coalesce(direction.build_fit_by_position[
          direction.subject_build_position], 1.0) end as build_term,
      case when cardinality(direction.preferred_practice) > 0
        then coalesce(direction.practice_fit_by_position[
          direction.subject_practice_position], 1.0) end as practice_term,
      case when cardinality(direction.desired_timeline) > 0
        then coalesce(direction.timeline_fit_by_position[
          direction.subject_timeline_position], 1.0) end as timeline_term,
      case when cardinality(direction.desired_family_goals) > 0
        then coalesce(direction.children_fit_by_position[
          direction.subject_children_position], 1.0) end as children_term,
      coalesce(power(
        greatest(0.01, least(1.0, config.f_relocation)),
        abs(direction.viewer_relocation_position
          - direction.subject_relocation_position)
      ), 1.0) as relocation_term,
      case when cardinality(direction.preferred_sects) > 0 then
        case when direction.subject_sect = 'prefer_not_to_say'
               or direction.subject_sect = any(direction.preferred_sects)
          then 1.0::numeric else config.sect_mismatch_score end
      end as sect_term,
      case
        when direction.same_country
          and direction.distance_km is not null
          and direction.distance_km::numeric <= config.distance_free_km
          then 1.0::numeric
        when direction.same_country and direction.distance_km is not null
          then greatest(0.0::numeric,
          1.0 - (direction.distance_km::numeric - config.distance_free_km)
            / greatest(1, direction.max_distance_km - config.distance_free_km))
        else 0.75::numeric
      end as distance_term,
      language_fit.term as languages_term
    from directions direction
    cross join score_config config
    cross join lateral (
      select least(1.0, count(*)::numeric / 2) as term
      from unnest(coalesce(direction.viewer_languages, '{}'::text[])) language(value)
      where language.value = any(coalesce(direction.subject_languages, '{}'::text[]))
    ) language_fit
  ),
  directional_scores as (
    select
      terms.user_low,
      terms.user_high,
      terms.viewer_id,
      case when totals.used_weight <= 0 then 0.5::numeric
        else round(least(1.0, greatest(0.0,
          totals.weighted_total / totals.used_weight)), 5)
      end as compatibility_score
    from directional_terms terms
    cross join lateral (
      values (
        terms.age_term * terms.w_age
          + coalesce(terms.height_term * terms.w_height, 0)
          + coalesce(terms.build_term * terms.w_build, 0)
          + coalesce(terms.practice_term * terms.w_practice, 0)
          + coalesce(terms.timeline_term * terms.w_timeline, 0)
          + coalesce(terms.children_term * terms.w_children, 0)
          + terms.relocation_term * terms.w_relocation
          + coalesce(terms.sect_term * terms.w_practice * 0.5, 0)
          + terms.distance_term * terms.w_distance
          + terms.languages_term * terms.w_languages,
        terms.w_age
          + case when terms.height_term is not null then terms.w_height else 0 end
          + case when terms.build_term is not null then terms.w_build else 0 end
          + case when terms.practice_term is not null then terms.w_practice else 0 end
          + case when terms.timeline_term is not null then terms.w_timeline else 0 end
          + case when terms.children_term is not null then terms.w_children else 0 end
          + terms.w_relocation
          + case when terms.sect_term is not null then terms.w_practice * 0.5 else 0 end
          + terms.w_distance
          + terms.w_languages
      )
    ) totals(weighted_total, used_weight)
  ),
  pair_scores as (
    select
      score.user_low,
      score.user_high,
      max(score.compatibility_score) filter (where score.viewer_id = score.user_low)
        as compat_low_to_high,
      max(score.compatibility_score) filter (where score.viewer_id = score.user_high)
        as compat_high_to_low
    from directional_scores score
    group by score.user_low, score.user_high
  )
  insert into halal_mode_private.matching_run_candidate_snapshots (
    run_id, user_low, user_high, compat_low_to_high, compat_high_to_low,
    pair_times_shown, pair_first_score, pair_last_score,
    cooldown_until, retired_at, explicit_pass_count, soft_select_count
  )
  select
    p_run_id,
    pair.user_low,
    pair.user_high,
    score.compat_low_to_high,
    score.compat_high_to_low,
    pair.pair_times_shown,
    pair.pair_first_score,
    pair.pair_last_score,
    pair.cooldown_until,
    pair.retired_at,
    pair.explicit_pass_count,
    pair.soft_select_count
  from batch_pairs pair
  join pair_scores score
    on score.user_low = pair.user_low and score.user_high = pair.user_high
  on conflict (run_id, user_low, user_high) do nothing;
  get diagnostics v_scored_rows = row_count;

  select
    v_run.candidate_edge_count - count(*),
    count(*)
  into v_remaining_rows, v_total_rows
  from halal_mode_private.matching_run_candidate_snapshots candidate
  where candidate.run_id = p_run_id;

  if v_total_rows > v_run.candidate_edge_count then
    raise exception 'The matching candidate shortlist is inconsistent'
      using errcode = '55000';
  end if;
  if v_remaining_rows > 0 and v_scored_rows = 0 then
    raise exception 'Candidate scoring made no progress'
      using errcode = '55000';
  end if;

  if v_remaining_rows = 0 then
    update halal_mode_private.matching_runs
    set candidate_snapshot_prepared_at = clock_timestamp()
    where id = p_run_id and candidate_snapshot_prepared_at is null;

    delete from halal_mode_private.matching_run_candidate_shortlists shortlist
    where shortlist.run_id = p_run_id;
  end if;

  return jsonb_build_object(
    'scored_rows', v_scored_rows,
    'remaining_rows', v_remaining_rows,
    'complete', v_remaining_rows = 0
  );
end;
$$;

revoke all on function public.matching_candidate_snapshot_score_batch_service(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.matching_candidate_snapshot_score_batch_service(uuid, integer)
  to service_role;
alter function public.matching_candidate_snapshot_score_batch_service(uuid, integer)
  set statement_timeout = '8s';

create or replace function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(
  p_run_id uuid,
  p_fail_limit bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set work_mem = '32MB' as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_config jsonb;
  v_male_count bigint;
  v_female_count bigint;
  v_potential_edge_count bigint;
  v_candidate_edge_count bigint;
  v_max_pair_appearances integer;
  v_lock_deadline timestamptz;
  v_scoring_complete boolean;
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
      'scoring_complete', v_run.candidate_snapshot_prepared_at is not null
    );
  end if;

  if exists (
    select 1
    from halal_mode_private.matching_run_candidate_shortlists shortlist
    where shortlist.run_id = p_run_id
  ) or exists (
    select 1
    from halal_mode_private.matching_run_candidate_snapshots candidate
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

  insert into halal_mode_private.matching_run_candidate_shortlists (
    run_id, user_low, user_high,
    pair_times_shown, pair_first_score, pair_last_score,
    cooldown_until, retired_at, explicit_pass_count, soft_select_count
  )
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
      coalesce(exposure.explicit_pass_count, 0) as explicit_pass_count,
      coalesce(exposure.soft_select_count, 0) as soft_select_count
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
      and coalesce(exposure.times_shown, 0) < v_max_pair_appearances
      and (exposure.cooldown_until is null
        or exposure.cooldown_until <= v_run.evaluated_at)
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
    p_run_id,
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
  where ranked.his_rank <= 40 or ranked.her_rank <= 40;
  get diagnostics v_candidate_edge_count = row_count;

  update halal_mode_private.matching_runs
  set candidate_shortlist_prepared_at = clock_timestamp(),
      candidate_snapshot_fail_limit = p_fail_limit,
      candidate_edge_count = v_candidate_edge_count,
      potential_edge_count = v_potential_edge_count
  where id = p_run_id;

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
  else
    v_scoring_complete := false;
  end if;

  return jsonb_build_object(
    'candidate_edge_count', v_candidate_edge_count,
    'potential_edge_count', v_potential_edge_count,
    'scoring_complete', v_scoring_complete
  );
end;
$$;

-- These row-at-a-time helpers were private implementation details of 0138.
-- Removing them prevents a later edit from accidentally restoring the slow
-- path or creating a second copy of the plausibility rules.
drop function if exists halal_mode_private.pair_apartness(
  halal_mode_private.matching_run_member_snapshots,
  halal_mode_private.matching_run_member_snapshots
);
drop function if exists halal_mode_private.snapshot_pair_is_plausible(
  halal_mode_private.matching_run_member_snapshots,
  halal_mode_private.matching_run_member_snapshots
);

revoke all on function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid, bigint)
  from public, anon, authenticated, service_role;

alter function public.matching_candidate_snapshot_prepare_service(uuid, bigint)
  set statement_timeout = '8s';

comment on function halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid, bigint) is
  'Freezes a bounded reciprocal shortlist using set-based eligibility over run snapshots; larger shortlists are scored by bounded service batches.';

comment on function public.matching_candidate_snapshot_score_batch_service(uuid, integer) is
  'Scores at most 500 frozen shortlist edges from frozen member columns. Repeated calls complete the candidate snapshot without a long API statement.';

-- Migration-time guard: function calls hidden in a future edit would recreate
-- the exact performance failure this migration removes.
do $$
declare
  definition text := pg_get_functiondef(
      'halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid,bigint)'::regprocedure
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
