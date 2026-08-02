-- Measure whether the matching is any good, and keep a trail of the answer.
--
-- matching_outcome_metrics() has existed since 0066 and has never run: it lives
-- in a schema PostgREST cannot reach and nothing calls it. The sixth thing here
-- found fully built and never invoked.
--
-- It also counted activity rather than quality. Keeps and connections rise
-- simply because more people joined; none of those six numbers can fall when
-- matching gets worse. The metrics that carry judgement are the ones that can:
-- what share of served members got nothing, how unevenly exposure is spread,
-- and how long somebody waits for a first mutual.
--
-- The gap that matters most is that nothing stored a result. A single call
-- answers "the last thirty days" as one lump, so nobody could ever see that
-- this week was worse than last — which is the only question worth asking now
-- that 0089 has the tuner adjusting weights on its own. An optimiser with no
-- instrument measuring its effect is the thing to actually worry about.

-- ---------------------------------------------------------------------------
-- Gini, mirroring gini() in src/matching/simulate.ts
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.gini(p_values numeric[])
returns numeric
language sql
immutable
set search_path = pg_catalog as $$
  with sorted as (
    select value,
           row_number() over (order by value) as i,
           count(*) over () as n
    from unnest(p_values) as t(value)
    where value is not null
  ), agg as (
    select sum(i * value) as weighted, sum(value) as total, max(n) as n from sorted
  )
  select case
    when n is null or n = 0 or total is null or total = 0 then 0
    else round((2 * weighted) / (n * total) - (n + 1)::numeric / n, 4)
  end
  from agg;
$$;

comment on function halal_mode_private.gini(numeric[]) is
  '0 is perfectly even, 1 is one member taking everything. Mirrors gini() in src/matching/simulate.ts so a simulated distribution and a real one are comparable.';

revoke all on function halal_mode_private.gini(numeric[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The metrics
-- ---------------------------------------------------------------------------
--
-- Every original key is kept, so anything already reading this keeps working.
-- What is added is the half that can get worse.

create or replace function halal_mode_private.matching_outcome_metrics(
  p_since timestamptz default now() - interval '30 days'
) returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with served as (
    select distinct r.user_id, r.tier
    from public.rounds r
    where r.opens_at >= p_since
  ), matched as (
    select distinct m.user_id
    from public.connections c
    cross join lateral (values (c.user_a), (c.user_b)) as m(user_id)
    where c.created_at >= p_since
  ), set_sizes as (
    select i.viewer_id, count(*)::numeric as shown
    from public.introductions i
    where i.created_at >= p_since
    group by i.viewer_id
  ), first_mutual as (
    select p.id, extract(epoch from (f.first_at - p.created_at)) / 86400 as days
    from public.profiles p
    join lateral (
      select min(c.created_at) as first_at
      from public.connections c
      where p.id in (c.user_a, c.user_b)
    ) f on true
    where f.first_at >= p_since
  )
  select jsonb_build_object(
    'since', p_since,
    -- Activity. These rise with the size of the pool and cannot fall when
    -- matching gets worse, so they describe scale rather than quality.
    'rounds_submitted', (
      select count(*) from public.rounds where submitted_at >= p_since
    ),
    'keeps', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and decided_at >= p_since
    ),
    'first_choices_made', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and rank = 1 and decided_at >= p_since
    ),
    'mutual_first_choices', (
      select count(*) from halal_mode_private.mutual_first_choices
      where matched_at >= p_since
    ),
    'connections_created', (
      select count(*) from public.connections where created_at >= p_since
    ),
    'contact_exchanged', (
      select count(*) from public.connections
      where contact_shared_at is not null and contact_shared_at >= p_since
    ),

    -- Quality. Each of these can get worse, which is the point of them.
    'members_served', (select count(*) from served),
    -- The single number to watch. If the tuner is hurting anyone, it shows here
    -- before it shows anywhere else.
    'zero_match_share', (
      select case when count(*) = 0 then null
        else round(1 - (
          select count(*)::numeric from served s
          where exists (select 1 from matched m where m.user_id = s.user_id)
        ) / count(*), 4) end
      from served
    ),
    -- 0 is everyone seeing the same number of people, 1 is one member taking
    -- everything. Fairness is the thing a scoring matcher quietly gives up.
    'exposure_gini', halal_mode_private.gini(array(select shown from set_sizes)),
    'mean_set_size', (
      select round(avg(shown), 2) from set_sizes
    ),
    'median_days_to_first_mutual', (
      select round(percentile_cont(0.5) within group (order by days)::numeric, 1)
      from first_mutual
    ),
    -- Of the keeps that were made, how many were returned. Falls when the
    -- estimator is pairing people who do not want each other.
    'mutual_rate', (
      select case when k = 0 then null else round(c::numeric / k, 4) end
      from (
        select (select count(*) from public.introduction_selections
                where decision = 'kept' and decided_at >= p_since) as k,
               (select count(*) from public.connections
                where created_at >= p_since) as c
      ) t
    ),

    -- Saying no, so the inference added in 0073-0084 can be seen working or
    -- misfiring. A pass rate near the round count means it fires constantly.
    'explicit_passes', (
      select count(*) from public.introduction_selections
      where decision = 'explicit_pass' and decided_at >= p_since
    ),
    'soft_selects', (
      select count(*) from public.introduction_selections
      where decision = 'soft_select' and decided_at >= p_since
    ),
    'hidden_pairs', (
      select count(*) from halal_mode_private.pair_exposure
      where retired_reason = 'hidden' and retired_at >= p_since
    ),

    -- Whoever is being served worst is the one to look at, and an average over
    -- both tiers hides exactly that.
    'by_tier', (
      select coalesce(jsonb_object_agg(t.tier, t.stats), '{}'::jsonb)
      from (
        select s.tier::text as tier,
               jsonb_build_object(
                 'members_served', count(*),
                 'zero_match_share', round(1 - (
                   count(*) filter (
                     where exists (select 1 from matched m where m.user_id = s.user_id)
                   )::numeric / count(*)
                 ), 4)
               ) as stats
        from served s
        group by s.tier
      ) t
    )
  );
$$;

revoke all on function halal_mode_private.matching_outcome_metrics(timestamptz)
  from public, anon, authenticated;
grant execute on function halal_mode_private.matching_outcome_metrics(timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- The trail
-- ---------------------------------------------------------------------------
--
-- One row per day. Keyed on the date so a re-run overwrites rather than
-- duplicating, which matters because the generator may retry a cycle.

create table if not exists halal_mode_private.matching_outcome_snapshots (
  captured_on   date primary key,
  window_days   integer not null check (window_days between 1 and 365),
  config_version integer references halal_mode_private.matching_config(version),
  metrics       jsonb not null,
  captured_at   timestamptz not null default now()
);

comment on table halal_mode_private.matching_outcome_snapshots is
  'A daily reading of matching_outcome_metrics, kept so trends exist. Records the config version in force, so a change in the numbers can be laid against a change in the settings — including the ones the tuner made on its own.';

revoke all on halal_mode_private.matching_outcome_snapshots
  from public, anon, authenticated;

create or replace function public.capture_matching_outcomes_service(
  p_window_days integer default 30
) returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_metrics jsonb;
begin
  if auth.uid() is not null then
    raise exception 'Not available' using errcode = '42501';
  end if;
  if p_window_days is null or p_window_days < 1 or p_window_days > 365 then
    raise exception 'Measurement window must be between 1 and 365 days'
      using errcode = '22023';
  end if;

  v_metrics := halal_mode_private.matching_outcome_metrics(
    now() - make_interval(days => p_window_days)
  );

  insert into halal_mode_private.matching_outcome_snapshots as s (
    captured_on, window_days, config_version, metrics
  )
  values (
    current_date,
    p_window_days,
    halal_mode_private.active_matching_config_version(),
    v_metrics
  )
  on conflict (captured_on) do update
    set window_days = excluded.window_days,
        config_version = excluded.config_version,
        metrics = excluded.metrics,
        captured_at = now();

  return v_metrics;
end;
$$;

comment on function public.capture_matching_outcomes_service(integer) is
  'Reads the outcome metrics and records them against today. Called once per generation cycle. Idempotent within a day, so a retried cycle overwrites rather than duplicating.';

revoke all on function public.capture_matching_outcomes_service(integer)
  from public, anon, authenticated;
grant execute on function public.capture_matching_outcomes_service(integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Run it, on the real database, rather than trusting that it parses
-- ---------------------------------------------------------------------------

do $$
declare
  v_metrics jsonb;
  v_rows int;
begin
  -- The arithmetic, on known inputs, since an empty database exercises none of
  -- it. These mirror the TypeScript gini() the simulation uses.
  assert halal_mode_private.gini(array[1, 1, 1, 1]::numeric[]) = 0,
    'an even distribution has no inequality';
  assert halal_mode_private.gini(array[]::numeric[]) = 0,
    'an empty distribution must not divide by zero';
  assert halal_mode_private.gini(array[0, 0, 0, 8]::numeric[]) > 0.7,
    'one member taking everything is near-total inequality';
  assert halal_mode_private.gini(array[1, 2, 3, 4]::numeric[]) between 0.2 and 0.3,
    'a mild spread reads as mild';

  -- Every query above, against the live schema. With no members most values are
  -- null, which is the honest answer and must not be a division by zero.
  v_metrics := public.capture_matching_outcomes_service(30);
  assert v_metrics ? 'zero_match_share', 'the quality half must be present';
  assert v_metrics ? 'exposure_gini', 'exposure fairness must be measured';
  assert v_metrics ? 'by_tier', 'the tier breakdown must be present';
  assert (v_metrics ->> 'members_served')::int = 0,
    'this project has no members yet, so nobody was served';

  select count(*) into v_rows from halal_mode_private.matching_outcome_snapshots;
  assert v_rows = 1, format('one snapshot should have been recorded; found %s', v_rows);

  -- Twice in a day is one row, because a retried cycle must not duplicate.
  perform public.capture_matching_outcomes_service(30);
  select count(*) into v_rows from halal_mode_private.matching_outcome_snapshots;
  assert v_rows = 1, format('a second capture today must overwrite; found %s rows', v_rows);
end;
$$;
