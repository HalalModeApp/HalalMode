-- Private reciprocal matching calibration.
--
-- This evolves the existing internal selection-feedback band into a reviewed,
-- gender-aware configuration. It is deliberately not a desirability score:
-- members cannot read it, it never appears in a DTO, and it is used only to
-- keep daily introductions broadly balanced across comparable feedback bands.
-- A mutual preference remains the non-negotiable eligibility gate.

create table if not exists halal_mode_private.matching_band_policies (
  gender gender primary key,
  -- Dampens feedback movement around the neutral midpoint. Values below one
  -- prevent small historical differences from turning into narrow cohorts.
  feedback_weight numeric(4,3) not null default 0.900
    check (feedback_weight between 0.500 and 1.000),
  updated_at timestamptz not null default now()
);

comment on table halal_mode_private.matching_band_policies is
  'Server-only reviewed matching policy. It may differ by gender only after an ethics and fairness review; it is never exposed to members.';

insert into halal_mode_private.matching_band_policies (gender, feedback_weight)
values ('male', 0.900), ('female', 0.900)
on conflict (gender) do nothing;

revoke all on table halal_mode_private.matching_band_policies
  from public, anon, authenticated;

-- Converts one private feedback value into a deliberately broad group. The
-- policy table makes any future gender-specific tuning reviewable in source and
-- in the database rather than embedding invisible criteria in application code.
create or replace function halal_mode_private.matching_band_for_score(
  p_gender gender,
  p_feedback_score numeric
) returns smallint
language plpgsql
stable
security definer
set search_path = halal_mode_private, public as $$
declare
  v_weight numeric;
  v_calibrated numeric;
begin
  select feedback_weight into v_weight
  from halal_mode_private.matching_band_policies
  where gender = p_gender;

  if v_weight is null then
    raise exception 'Matching policy is not configured for gender %', p_gender
      using errcode = 'P0001';
  end if;

  v_calibrated := 0.500 + (coalesce(p_feedback_score, 0.500) - 0.500) * v_weight;
  return greatest(1, least(5, ceil(greatest(0.05, least(0.95, v_calibrated)) * 5)::smallint));
end;
$$;

create or replace function halal_mode_private.matching_band_for_member(p_user uuid)
returns smallint
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select halal_mode_private.matching_band_for_score(
    p.gender,
    coalesce(s.score, 0.5000)
  )
  from public.profiles p
  left join public.selection_scores s on s.user_id = p.id
  where p.id = p_user;
$$;

-- Keep the persisted internal band in sync for the daily pair graph and future
-- batch jobs. Policy updates use the service-only routine below, which
-- recalculates every affected stored band atomically.
create or replace function halal_mode_private.sync_selection_score_band()
returns trigger
language plpgsql
security definer
set search_path = halal_mode_private, public as $$
declare
  v_gender gender;
begin
  select gender into v_gender from public.profiles where id = new.user_id;
  if v_gender is null then
    raise exception 'Selection score requires a profile' using errcode = '23503';
  end if;
  new.band := halal_mode_private.matching_band_for_score(v_gender, new.score);
  return new;
end;
$$;

drop trigger if exists sync_selection_score_band on public.selection_scores;
create trigger sync_selection_score_band
before insert or update of score on public.selection_scores
for each row execute function halal_mode_private.sync_selection_score_band();

update public.selection_scores s
set band = halal_mode_private.matching_band_for_score(p.gender, s.score)
from public.profiles p
where p.id = s.user_id;

-- Policy changes are rare and must recalculate every persisted band in the
-- same transaction. Keeping bands materialized makes the daily pair graph a
-- cheap indexed join rather than a per-candidate policy lookup at scale.
create or replace function halal_mode_private.set_matching_band_policy(
  p_gender gender,
  p_feedback_weight numeric
) returns void
language plpgsql
security definer
set search_path = halal_mode_private, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Matching policy changes require service role' using errcode = '42501';
  end if;
  if p_feedback_weight is null or p_feedback_weight not between 0.500 and 1.000 then
    raise exception 'Feedback weight must be between 0.500 and 1.000' using errcode = '22023';
  end if;

  update halal_mode_private.matching_band_policies
  set feedback_weight = p_feedback_weight, updated_at = now()
  where gender = p_gender;
  if not found then raise exception 'Matching policy is not configured for gender %', p_gender using errcode = 'P0002'; end if;

  update public.selection_scores s
  set band = halal_mode_private.matching_band_for_score(p.gender, s.score)
  from public.profiles p
  where p.id = s.user_id and p.gender = p_gender;
end;
$$;

-- International introductions are entirely reciprocal. A member who is open
-- internationally may see another country only when their own country list
-- accepts that country (or they have no country restriction). Their counterpart
-- must pass the exact same test in the reverse direction through
-- passes_criteria(). Local distance caps remain meaningful only for local pairs;
-- an explicitly reciprocal cross-country choice is never silently rejected by
-- a kilometre radius.
create or replace function halal_mode_private.accepts_subject_country(
  p_viewer uuid,
  p_subject uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_profile profiles%rowtype;
  s_profile profiles%rowtype;
  v_preferences private_preferences%rowtype;
begin
  select * into v_profile from profiles where id = p_viewer;
  select * into s_profile from profiles where id = p_subject;
  select * into v_preferences from private_preferences where user_id = p_viewer;
  if v_profile is null or s_profile is null or v_preferences is null then return false; end if;

  if lower(trim(v_profile.country)) = lower(trim(s_profile.country)) then
    return true;
  end if;

  if v_profile.relocation not in ('open', 'willing_abroad') then
    return false;
  end if;

  if coalesce(array_length(v_preferences.preferred_countries, 1), 0) = 0 then
    return true;
  end if;

  return exists (
    select 1
    from unnest(v_preferences.preferred_countries) as allowed(country)
    where lower(trim(allowed.country)) = lower(trim(s_profile.country))
  );
end;
$$;

create or replace function passes_criteria(p_viewer uuid, p_subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v private_preferences%rowtype;
  s profiles%rowtype;
  vp profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
begin
  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;

  if v is null or s is null or vp is null then return false; end if;
  if s.gender = vp.gender or s.is_paused or not s.onboarding_complete then return false; end if;

  s_age := extract(year from age(s.birth_date));
  if s_age < v.min_age or s_age > v.max_age then return false; end if;

  if s_prefs.own_height_cm is not null
     and (s_prefs.own_height_cm < v.min_height_cm or s_prefs.own_height_cm > v.max_height_cm) then
    return false;
  end if;
  if array_length(v.preferred_builds, 1) is not null
     and s_prefs.own_build is not null
     and not (s_prefs.own_build = any (v.preferred_builds)) then return false; end if;
  if array_length(v.preferred_practice, 1) is not null
     and not (s.religious_practice = any (v.preferred_practice)) then return false; end if;
  if array_length(v.desired_timeline, 1) is not null
     and not (s.timeline = any (v.desired_timeline)) then return false; end if;

  if not halal_mode_private.accepts_subject_country(p_viewer, p_subject) then return false; end if;

  if lower(trim(vp.country)) = lower(trim(s.country))
     and vp.latitude is not null and s.latitude is not null
     and distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude) > v.max_distance_km then
    return false;
  end if;

  if exists (
    select 1 from blocks
    where (blocker_id = p_viewer and blocked_id = p_subject)
       or (blocker_id = p_subject and blocked_id = p_viewer)
  ) then return false; end if;
  return true;
end;
$$;

-- The pair graph remains reciprocal. Only the broad, private calibration band
-- changes; eligibility still requires passes_criteria() in both directions.
create or replace function generate_round_for_pairs(p_expires_at timestamptz)
returns int
language plpgsql security definer set search_path = public, halal_mode_private as $$
declare
  pair record;
  round_a uuid;
  round_b uuid;
  intro_a uuid;
  intro_b uuid;
  created int := 0;
begin
  insert into rounds (user_id, tier, expires_at)
  select p.id, p.tier, p_expires_at
  from profiles p
  where p.onboarding_complete and not p.is_paused
    and not exists (select 1 from rounds r where r.user_id = p.id and r.submitted_at is null);

  for pair in
    with eligible as (
      select p.id, p.gender, p.tier, coalesce(s.band, 3) as band
      from profiles p
      left join selection_scores s on s.user_id = p.id
      where p.onboarding_complete and not p.is_paused
    ),
    candidates as (
      select m.id as male_id, f.id as female_id,
             abs(m.band - f.band) as band_gap, random() as jitter
      from eligible m
      join eligible f on f.gender = 'female'
      where m.gender = 'male'
        and abs(m.band - f.band) <= 1
        and passes_criteria(m.id, f.id)
        and passes_criteria(f.id, m.id)
        and not exists (
          select 1 from introductions i
          where (i.viewer_id = m.id and i.subject_id = f.id)
             or (i.viewer_id = f.id and i.subject_id = m.id)
        )
    ),
    ranked as (
      select *,
        row_number() over (partition by male_id order by band_gap, jitter) as male_rank,
        row_number() over (partition by female_id order by band_gap, jitter) as female_rank
      from candidates
    )
    select r.male_id, r.female_id
    from ranked r
    join eligible em on em.id = r.male_id
    join eligible ef on ef.id = r.female_id
    where r.male_rank <= (select introductions from tier_limits(em.tier))
      and r.female_rank <= (select introductions from tier_limits(ef.tier))
  loop
    select id into round_a from rounds where user_id = pair.male_id and submitted_at is null limit 1;
    select id into round_b from rounds where user_id = pair.female_id and submitted_at is null limit 1;
    continue when round_a is null or round_b is null;

    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_a, pair.male_id, pair.female_id, agreement_summary(pair.male_id, pair.female_id))
    on conflict (round_id, subject_id) do nothing returning id into intro_a;
    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_b, pair.female_id, pair.male_id, agreement_summary(pair.female_id, pair.male_id))
    on conflict (round_id, subject_id) do nothing returning id into intro_b;

    if intro_a is not null and intro_b is not null then
      update introductions set reciprocal_id = intro_b where id = intro_a;
      update introductions set reciprocal_id = intro_a where id = intro_b;
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;

revoke all on function halal_mode_private.matching_band_for_score(gender, numeric)
  from public, anon, authenticated;
revoke all on function halal_mode_private.matching_band_for_member(uuid)
  from public, anon, authenticated;
revoke all on function halal_mode_private.sync_selection_score_band()
  from public, anon, authenticated;
revoke all on function halal_mode_private.set_matching_band_policy(gender, numeric)
  from public, anon, authenticated;
revoke all on function halal_mode_private.accepts_subject_country(uuid, uuid)
  from public, anon, authenticated;
revoke all on function passes_criteria(uuid, uuid)
  from public, anon, authenticated;
revoke all on function generate_round_for_pairs(timestamptz)
  from public, anon, authenticated;
