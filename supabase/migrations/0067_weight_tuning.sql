-- Weights that learn from outcomes, within bounds, with a record of every move.
--
-- The weights in `matching_config` were chosen from judgement about what
-- matters in a marriage. Judgement is the right starting point and a poor
-- stopping point: whether religious practice really predicts a mutual first
-- choice twice as strongly as build is an empirical question, and the answer
-- will differ by pool and drift over time.
--
-- Three things make this safe rather than merely automatic.
--
--   Bounded  — no weight moves more than `max_weight_step` per cycle, and none
--              leaves its reviewed range. A bad signal can nudge; it cannot
--              take over.
--   Recorded — every adjustment writes the old value, the new value, the lift
--              that caused it and the sample it was computed from. An
--              adjustment nobody can reconstruct is not one anybody can trust,
--              and these weights encode judgements about religion and marriage.
--   Earned   — nothing moves until a criterion has enough observed pairs. Small
--              samples produce large apparent effects, and acting on them is
--              how a matcher teaches itself something untrue.

-- ---------------------------------------------------------------------------
-- What each criterion contributed, for the pairs actually shown
--
-- Tuning needs to know what the score *was* when the introduction was made.
-- Recomputing later would read today's profiles and preferences, which have
-- since changed — the model would be corrected against inputs it never saw.
-- ---------------------------------------------------------------------------

alter table public.introductions
  add column if not exists criterion_scores jsonb;

comment on column public.introductions.criterion_scores is
  'Per-criterion compatibility at the moment this introduction was created, for offline tuning. Never returned to any member.';

/**
 * Directional compatibility, broken out per criterion.
 *
 * Same inputs and same shape as `compatibility()`, returning the parts instead
 * of the weighted total. Kept separate so the scoring path stays a single
 * number and this stays an analysis concern.
 */
create or replace function halal_mode_private.compatibility_breakdown(
  p_viewer uuid,
  p_subject uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb;
  f jsonb;
  v private_preferences%rowtype;
  vp profiles%rowtype;
  s profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
  parts jsonb := '{}'::jsonb;
  best numeric;
  distance numeric;
  free_km numeric;
begin
  cfg := halal_mode_private.active_matching_config();
  f := coalesce(cfg -> 'falloff', '{}'::jsonb);
  free_km := coalesce((cfg ->> 'distance_free_km')::numeric, 25);

  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;
  if v is null or vp is null or s is null then return parts; end if;

  s_age := extract(year from age(s.birth_date));
  parts := parts || jsonb_build_object('age',
    case when s_age between v.min_age and v.max_age then 1.0
    else greatest(0, 1 - (
      case when s_age < v.min_age then v.min_age - s_age else s_age - v.max_age end
    )::numeric / greatest(1, v.max_age - v.min_age)) end);

  if s_prefs.own_height_cm is not null then
    parts := parts || jsonb_build_object('height',
      case when s_prefs.own_height_cm between v.min_height_cm and v.max_height_cm then 1.0
      else greatest(0, 1 - (
        case when s_prefs.own_height_cm < v.min_height_cm
          then v.min_height_cm - s_prefs.own_height_cm
          else s_prefs.own_height_cm - v.max_height_cm end
      )::numeric / greatest(1, v.max_height_cm - v.min_height_cm)) end);
  end if;

  if array_length(v.preferred_builds, 1) is not null and s_prefs.own_build is not null then
    select max(halal_mode_private.scale_proximity('build', wanted.value, s_prefs.own_build,
      coalesce((f ->> 'build')::numeric, 0.88))) into best
    from unnest(v.preferred_builds) wanted(value);
    parts := parts || jsonb_build_object('build', coalesce(best, 1.0));
  end if;

  if array_length(v.preferred_practice, 1) is not null then
    select max(halal_mode_private.scale_proximity('practice', wanted.value::text,
      s.religious_practice::text, coalesce((f ->> 'practice')::numeric, 0.70))) into best
    from unnest(v.preferred_practice) wanted(value);
    parts := parts || jsonb_build_object('practice', coalesce(best, 1.0));
  end if;

  if array_length(v.desired_timeline, 1) is not null then
    select max(halal_mode_private.scale_proximity('timeline', wanted.value::text,
      s.timeline::text, coalesce((f ->> 'timeline')::numeric, 0.85))) into best
    from unnest(v.desired_timeline) wanted(value);
    parts := parts || jsonb_build_object('timeline', coalesce(best, 1.0));
  end if;

  if array_length(v.desired_family_goals, 1) is not null then
    select max(halal_mode_private.scale_proximity('children', wanted.value::text,
      s.family_goals::text, coalesce((f ->> 'children')::numeric, 0.65))) into best
    from unnest(v.desired_family_goals) wanted(value);
    parts := parts || jsonb_build_object('children', coalesce(best, 1.0));
  end if;

  parts := parts || jsonb_build_object('relocation',
    halal_mode_private.scale_proximity('relocation', vp.relocation::text,
      s.relocation::text, coalesce((f ->> 'relocation')::numeric, 0.80)));

  if array_length(v.preferred_sects, 1) is not null then
    parts := parts || jsonb_build_object('sect',
      case when s.sect = 'prefer_not_to_say' or s.sect = any (v.preferred_sects) then 1.0
      else coalesce((cfg ->> 'sect_mismatch_score')::numeric, 0.15) end);
  end if;

  if lower(trim(vp.country)) = lower(trim(s.country))
     and vp.latitude is not null and s.latitude is not null then
    distance := distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude);
    parts := parts || jsonb_build_object('distance',
      case when distance <= free_km then 1.0
      else greatest(0, 1 - (distance - free_km) / greatest(1, v.max_distance_km - free_km)) end);
  else
    parts := parts || jsonb_build_object('distance', 0.75);
  end if;

  parts := parts || jsonb_build_object('languages', least(1.0, (
    select count(*)::numeric / 2
    from unnest(coalesce(vp.languages_spoken, '{}')) l(lang)
    where lang = any (coalesce(s.languages_spoken, '{}'))
  )));

  return parts;
end;
$$;

-- ---------------------------------------------------------------------------
-- The audit trail
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.matching_weight_adjustments (
  id             bigint generated always as identity primary key,
  from_version   integer not null references halal_mode_private.matching_config(version),
  to_version     integer not null references halal_mode_private.matching_config(version),
  criterion      text not null,
  old_weight     numeric(5,4) not null,
  new_weight     numeric(5,4) not null,
  -- Difference in mutual-first-choice rate between pairs that scored well on
  -- this criterion and pairs that scored poorly. The reason for the move.
  observed_lift  numeric(6,5),
  sample_size    integer not null,
  created_at     timestamptz not null default now()
);

comment on table halal_mode_private.matching_weight_adjustments is
  'Every automatic weight change, with the evidence that caused it. Auto-tuning that cannot be reconstructed is not auditable, and these weights encode judgements about religion and marriage.';

revoke all on table halal_mode_private.matching_weight_adjustments
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Measured lift per criterion
--
-- For each criterion: among the pairs actually shown, how much more often did a
-- mutual first choice occur when the pair scored well on it than when they
-- scored poorly?
--
-- Deliberately a difference of two rates rather than a regression. With a few
-- hundred members there is not enough data to fit anything more, and a simple
-- statistic that can be checked by hand is worth more than a better one nobody
-- can audit.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.criterion_lift(
  p_since timestamptz default now() - interval '90 days'
) returns table (criterion text, lift numeric, sample_size integer)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with shown as (
    select
      i.id,
      i.criterion_scores,
      exists (
        select 1
        from public.introduction_selections mine
        join public.introduction_selections theirs
          on theirs.viewer_id = mine.subject_id
         and theirs.subject_id = mine.viewer_id
         and theirs.decision = 'kept' and theirs.rank = 1
        where mine.introduction_id = i.id
          and mine.decision = 'kept' and mine.rank = 1
      ) as mutual_first
    from public.introductions i
    join public.rounds r on r.id = i.round_id
    where i.criterion_scores is not null
      and r.submitted_at is not null
      and r.submitted_at >= p_since
  ),
  spread as (
    select
      key as criterion,
      (value #>> '{}')::numeric as score,
      mutual_first
    from shown, lateral jsonb_each(shown.criterion_scores)
  )
  select
    criterion,
    coalesce(
      avg(case when score >= 0.7 then (mutual_first)::int end)
        - avg(case when score < 0.4 then (mutual_first)::int end),
      0
    )::numeric,
    count(*)::int
  from spread
  group by criterion;
$$;

-- ---------------------------------------------------------------------------
-- The tuner
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.tune_matching_weights()
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  cfg jsonb;
  weights jsonb;
  next_weights jsonb := '{}'::jsonb;
  from_version int;
  to_version int;
  max_step numeric;
  min_w numeric;
  max_w numeric;
  min_samples int;
  gain numeric;
  total numeric := 0;
  row_lift record;
  criterion text;
  old_w numeric;
  new_w numeric;
  moved int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Weight tuning requires service role' using errcode = '42501';
  end if;

  cfg := halal_mode_private.active_matching_config();
  from_version := halal_mode_private.active_matching_config_version();
  if coalesce((cfg ->> 'tuning_enabled')::boolean, false) is not true then
    return jsonb_build_object('skipped', 'tuning_disabled');
  end if;

  weights := coalesce(cfg -> 'weights', '{}'::jsonb);
  max_step := coalesce((cfg ->> 'max_weight_step')::numeric, 0.02);
  min_w := coalesce((cfg ->> 'min_criterion_weight')::numeric, 0.01);
  max_w := coalesce((cfg ->> 'max_criterion_weight')::numeric, 0.35);
  min_samples := coalesce((cfg ->> 'tuning_min_samples')::int, 200);
  gain := coalesce((cfg ->> 'tuning_gain')::numeric, 0.5);

  -- Start from the current weights; anything without enough evidence stays put.
  next_weights := weights;

  for row_lift in
    select * from halal_mode_private.criterion_lift()
  loop
    criterion := row_lift.criterion;
    if not (weights ? criterion) then continue; end if;
    if row_lift.sample_size < min_samples then continue; end if;

    old_w := (weights ->> criterion)::numeric;
    new_w := old_w * (1 + gain * row_lift.lift);

    -- Bounded in both senses: a limited move, inside a reviewed range.
    new_w := least(old_w + max_step, greatest(old_w - max_step, new_w));
    new_w := least(max_w, greatest(min_w, new_w));

    if abs(new_w - old_w) < 0.0005 then continue; end if;
    next_weights := next_weights || jsonb_build_object(criterion, round(new_w, 4));
    moved := moved + 1;
  end loop;

  if moved = 0 then
    return jsonb_build_object('skipped', 'no_criterion_had_enough_evidence');
  end if;

  -- Renormalise so the weights still describe shares of one whole.
  select sum((value #>> '{}')::numeric) into total from jsonb_each(next_weights);
  if total is null or total <= 0 then
    return jsonb_build_object('skipped', 'degenerate_weights');
  end if;
  select jsonb_object_agg(key, round(((value #>> '{}')::numeric / total), 4))
  into next_weights from jsonb_each(next_weights);

  to_version := from_version + 1;
  insert into halal_mode_private.matching_config (version, params, notes, activated_at)
  values (
    to_version,
    cfg || jsonb_build_object('weights', next_weights),
    'Automatic weight adjustment from observed mutual first choices.',
    now()
  );

  for row_lift in select * from halal_mode_private.criterion_lift() loop
    if not (weights ? row_lift.criterion) then continue; end if;
    insert into halal_mode_private.matching_weight_adjustments (
      from_version, to_version, criterion, old_weight, new_weight,
      observed_lift, sample_size
    ) values (
      from_version, to_version, row_lift.criterion,
      (weights ->> row_lift.criterion)::numeric,
      (next_weights ->> row_lift.criterion)::numeric,
      row_lift.lift, row_lift.sample_size
    );
  end loop;

  return jsonb_build_object(
    'from_version', from_version,
    'to_version', to_version,
    'criteria_moved', moved,
    'weights', next_weights
  );
end;
$$;

-- Tuning ships disabled. It has nothing to learn from until real rounds have
-- run, and a tuner fed no evidence should do nothing rather than drift.
insert into halal_mode_private.matching_config (version, params, notes, activated_at)
select
  4,
  params || jsonb_build_object(
    'tuning_enabled', false,
    'max_weight_step', 0.02,
    'min_criterion_weight', 0.01,
    'max_criterion_weight', 0.35,
    'tuning_min_samples', 200,
    'tuning_gain', 0.5
  ),
  'Adds bounded automatic weight tuning, disabled until outcomes exist.',
  now()
from halal_mode_private.matching_config
where version = 3;

revoke all on function halal_mode_private.compatibility_breakdown(uuid, uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.criterion_lift(timestamptz)
  from public, anon, authenticated;
revoke all on function halal_mode_private.tune_matching_weights()
  from public, anon, authenticated;
grant execute on function halal_mode_private.tune_matching_weights() to service_role;
