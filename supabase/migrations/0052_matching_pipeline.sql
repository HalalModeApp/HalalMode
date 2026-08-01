-- The reciprocal matching pipeline: prefilter, signals, persistence.
--
-- Three responsibilities move here from the monolithic generator:
--
--   1. A set-based prefilter, so cheap conditions remove pairs before the
--      expensive per-pair check runs. `passes_criteria` is STABLE SECURITY
--      DEFINER PL/pgSQL and cannot be inlined, so calling it on every pair in
--      the pool is what makes the current generator quadratic with a large
--      constant. It stays the authority on eligibility; it is simply asked
--      about far fewer pairs.
--
--   2. Per-member signals for estimation and fairness, read once per run.
--
--   3. One transactional writer that persists a decided round, links the
--      reciprocal twins and records pair exposure together.
--
-- Scoring, allocation and rotation are deliberately not here. They live in the
-- Edge Function, where sorting a large edge list is cheap, the repair pass can
-- hold a real clock, and shadow mode is a pure function that writes nowhere.

-- ---------------------------------------------------------------------------
-- Directional compatibility
--
-- How well the subject fits the viewer's stated preferences, normalised to
-- [0,1]. Built only from fields that already exist. This is the cold-start
-- signal: a member with no behavioural history is scored entirely on this, so
-- newcomers start neutral rather than penalised.
--
-- Not a desirability score. It is directional, it is about fit between two
-- people, and no client role can reach it.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.compatibility(
  p_viewer uuid,
  p_subject uuid
) returns numeric
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v private_preferences%rowtype;
  vp profiles%rowtype;
  s profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
  terms numeric[] := '{}';
  span numeric;
  distance numeric;
begin
  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;
  if v is null or vp is null or s is null then return 0; end if;

  -- Age: 1 at the centre of the accepted range, tapering to 0 at its edges.
  s_age := extract(year from age(s.birth_date));
  span := greatest(1, v.max_age - v.min_age);
  terms := terms || greatest(0, 1 - (abs(s_age - (v.min_age + v.max_age) / 2.0) / (span / 2.0)));

  -- Height, on the same shape, when the subject has recorded one.
  if s_prefs.own_height_cm is not null then
    span := greatest(1, v.max_height_cm - v.min_height_cm);
    terms := terms || greatest(0, 1 - (
      abs(s_prefs.own_height_cm - (v.min_height_cm + v.max_height_cm) / 2.0) / (span / 2.0)
    ));
  end if;

  -- Practice and timeline are categorical: stated preference met, or not.
  if array_length(v.preferred_practice, 1) is not null then
    terms := terms || (case when s.religious_practice = any (v.preferred_practice) then 1 else 0 end)::numeric;
  end if;
  if array_length(v.desired_timeline, 1) is not null then
    terms := terms || (case when s.timeline = any (v.desired_timeline) then 1 else 0 end)::numeric;
  end if;

  -- Proximity, as a fraction of the viewer's own radius. Cross-country pairs
  -- are already an explicit reciprocal choice, so they score neutral rather
  -- than being penalised for distance.
  if lower(trim(vp.country)) = lower(trim(s.country))
     and vp.latitude is not null and s.latitude is not null then
    distance := distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude);
    terms := terms || greatest(0, 1 - (distance / greatest(1, v.max_distance_km)));
  else
    terms := terms || 0.5::numeric;
  end if;

  -- Shared languages, capped so a polyglot does not dominate the mean.
  terms := terms || least(1.0, (
    select count(*)::numeric / 2
    from unnest(coalesce(vp.languages_spoken, '{}')) l(lang)
    where lang = any (coalesce(s.languages_spoken, '{}'))
  ));

  if array_length(terms, 1) is null then return 0.5; end if;
  return round((select avg(t) from unnest(terms) t), 5);
end;
$$;

-- ---------------------------------------------------------------------------
-- The eligible pool
--
-- Adds the capacity gate the product rules require: a member at their active
-- match cap stops receiving rounds, and resumes when they drop back under it.
-- Previously capacity was only enforced when a match was created, so a member
-- who was already full still consumed introductions.
-- ---------------------------------------------------------------------------

create or replace view halal_mode_private.matching_pool as
select
  p.id,
  p.gender,
  p.tier,
  p.country,
  p.latitude,
  p.longitude,
  extract(year from age(p.birth_date))::int as age,
  l.introductions as introductions_per_round,
  h.qualified_exposures,
  h.times_picked_by_others,
  h.rounds_since_last_mutual,
  h.rounds_since_last_served,
  h.active_match_count,
  h.model_confidence,
  l.open_connections as active_match_cap
from public.profiles p
cross join lateral tier_limits(p.tier) l
join halal_mode_private.match_health h on h.user_id = p.id
where p.onboarding_complete
  and not p.is_paused
  and public.profile_is_ready_for_matching(p.id)
  -- Rounds pause at the cap and resume automatically underneath it.
  and h.active_match_count < l.open_connections;

revoke all on halal_mode_private.matching_pool from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Candidate edges
--
-- Cheap set-based conditions are applied first, in the CTE, so `passes_criteria`
-- is only asked about pairs that already survived age, country and block
-- filtering. Cooled-down, retired and repeat-exhausted pairs are excluded here
-- rather than after scoring.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.matching_candidate_edges(
  p_max_edges integer default 500000
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
set search_path = public, halal_mode_private as $$
  with cfg as (
    select
      coalesce((halal_mode_private.active_matching_config() ->> 'max_pair_appearances')::int, 3) as max_appearances
  ),
  cheap as (
    select
      least(m.id, f.id) as user_low,
      greatest(m.id, f.id) as user_high,
      m.id as male_id,
      f.id as female_id
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    cross join cfg
    where m.gender = 'male'
      -- Blocks and explicit passes are set operations; do them before the
      -- per-pair function call.
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = m.id and b.blocked_id = f.id)
           or (b.blocker_id = f.id and b.blocked_id = m.id)
      )
      and not exists (
        select 1
        from public.introduction_selections sel
        where sel.decision = 'explicit_pass'
          and ((sel.viewer_id = m.id and sel.subject_id = f.id)
            or (sel.viewer_id = f.id and sel.subject_id = m.id))
      )
      and not exists (
        select 1
        from halal_mode_private.pair_exposure pe
        where pe.user_low = least(m.id, f.id)
          and pe.user_high = greatest(m.id, f.id)
          and (
            pe.retired_at is not null
            or pe.times_shown >= cfg.max_appearances
            or (pe.cooldown_until is not null and pe.cooldown_until > now())
          )
      )
  )
  select
    c.user_low,
    c.user_high,
    halal_mode_private.compatibility(c.user_low, c.user_high),
    halal_mode_private.compatibility(c.user_high, c.user_low),
    coalesce(pe.times_shown, 0),
    pe.first_reciprocal_score
  from cheap c
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = c.user_low and pe.user_high = c.user_high
  -- The authority on eligibility, now asked about far fewer pairs.
  where passes_criteria(c.male_id, c.female_id)
    and passes_criteria(c.female_id, c.male_id)
  limit p_max_edges;
$$;

-- ---------------------------------------------------------------------------
-- Per-member signals for estimation, fairness and rotation.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.matching_member_signals()
returns table (
  user_id uuid,
  gender gender,
  tier membership_tier,
  times_shown integer,
  times_kept integer,
  rounds_since_last_mutual integer,
  rounds_since_last_served integer,
  exposures_in_window integer,
  introductions_per_round integer
)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with cfg as (
    select coalesce((halal_mode_private.active_matching_config() ->> 'exposure_window_rounds')::int, 7) as window_rounds
  )
  select
    pool.id,
    pool.gender,
    pool.tier,
    pool.qualified_exposures::int,
    pool.times_picked_by_others::int,
    pool.rounds_since_last_mutual::int,
    pool.rounds_since_last_served::int,
    (
      select count(*)::int
      from public.introductions i
      join public.rounds r on r.id = i.round_id
      where i.viewer_id = pool.id
        and r.opens_at > now() - make_interval(days => (select window_rounds from cfg))
    ),
    pool.introductions_per_round::int
  from halal_mode_private.matching_pool pool;
$$;

-- ---------------------------------------------------------------------------
-- Persisting a decided round
--
-- One transaction. Creates the rounds, writes both twins of every edge, links
-- them, and records pair exposure. Reciprocity is asserted here as well as in
-- the allocator: a silently one-sided introduction is worse than no round.
--
-- `p_edges` is [{"a": uuid, "b": uuid, "score": numeric}, ...].
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.persist_matching_round(
  p_run_id uuid,
  p_edges jsonb,
  p_expires_at timestamptz
) returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  edge record;
  round_a uuid;
  round_b uuid;
  intro_a uuid;
  intro_b uuid;
  created int := 0;
  cooldown_days int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Round persistence requires service role' using errcode = '42501';
  end if;
  if not exists (
    select 1 from halal_mode_private.matching_runs
    where id = p_run_id and mode = 'live'
  ) then
    raise exception 'A live run is required to persist a round' using errcode = '22023';
  end if;

  cooldown_days := coalesce(
    (halal_mode_private.active_matching_config() ->> 'repeat_cooldown_days')::int, 14
  );

  -- Only members appearing in the decided edge set receive a round. Members
  -- deferred by rotation get none, which is what `awaiting_turn` explains.
  insert into rounds (user_id, tier, expires_at)
  select distinct m.id, m.tier, p_expires_at
  from halal_mode_private.matching_pool m
  where m.id in (
    select (e ->> 'a')::uuid from jsonb_array_elements(p_edges) e
    union
    select (e ->> 'b')::uuid from jsonb_array_elements(p_edges) e
  )
  and not exists (
    select 1 from rounds r where r.user_id = m.id and r.submitted_at is null
  );

  for edge in
    select (e ->> 'a')::uuid as a, (e ->> 'b')::uuid as b,
           coalesce((e ->> 'score')::numeric, 0) as score
    from jsonb_array_elements(p_edges) e
  loop
    select id into round_a from rounds
      where user_id = edge.a and submitted_at is null limit 1;
    select id into round_b from rounds
      where user_id = edge.b and submitted_at is null limit 1;
    continue when round_a is null or round_b is null;

    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_a, edge.a, edge.b, agreement_summary(edge.a, edge.b))
    on conflict (round_id, subject_id) do nothing
    returning id into intro_a;

    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_b, edge.b, edge.a, agreement_summary(edge.b, edge.a))
    on conflict (round_id, subject_id) do nothing
    returning id into intro_b;

    -- Both halves, or neither. A half-written pair would be a one-sided
    -- introduction, which the product must never produce.
    if intro_a is null or intro_b is null then
      if intro_a is not null then delete from introductions where id = intro_a; end if;
      if intro_b is not null then delete from introductions where id = intro_b; end if;
      continue;
    end if;

    update introductions set reciprocal_id = intro_b where id = intro_a;
    update introductions set reciprocal_id = intro_a where id = intro_b;

    insert into halal_mode_private.pair_exposure as pe (
      user_low, user_high, times_shown, first_reciprocal_score,
      last_reciprocal_score, last_shown_at, last_round_id, cooldown_until
    )
    values (
      least(edge.a, edge.b), greatest(edge.a, edge.b), 1, edge.score,
      edge.score, now(), round_a, now() + make_interval(days => cooldown_days)
    )
    on conflict (user_low, user_high) do update set
      times_shown = pe.times_shown + 1,
      last_reciprocal_score = excluded.last_reciprocal_score,
      last_shown_at = now(),
      last_round_id = excluded.last_round_id,
      cooldown_until = excluded.cooldown_until;

    created := created + 1;
  end loop;

  update halal_mode_private.matching_runs
  set pairs_created = created, finished_at = now()
  where id = p_run_id;

  return created;
end;
$$;

revoke all on function halal_mode_private.compatibility(uuid, uuid) from public, anon, authenticated;
revoke all on function halal_mode_private.matching_candidate_edges(integer) from public, anon, authenticated;
revoke all on function halal_mode_private.matching_member_signals() from public, anon, authenticated;
revoke all on function halal_mode_private.persist_matching_round(uuid, jsonb, timestamptz) from public, anon, authenticated;

grant execute on function halal_mode_private.matching_candidate_edges(integer) to service_role;
grant execute on function halal_mode_private.matching_member_signals() to service_role;
grant execute on function halal_mode_private.persist_matching_round(uuid, jsonb, timestamptz) to service_role;
