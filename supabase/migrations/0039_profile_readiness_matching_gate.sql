-- A completed profile and explicitly saved matching preferences are required
-- before a member receives or occupies a daily introduction slot. This is
-- enforced in the generator and read boundary, never just hidden in the app.

alter table public.private_preferences
  add column if not exists matching_preferences_completed_at timestamptz;

create or replace function public.mark_matching_preferences_complete()
returns trigger
language plpgsql
set search_path = public as $$
begin
  -- Direct table access is revoked. The reviewed preference RPC is the normal
  -- path here, so a save represents an intentional confirmation of the basic
  -- matching choices rather than a migration backfill silently opting someone in.
  if new.matching_preferences_completed_at is null then
    new.matching_preferences_completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists private_preferences_mark_complete on public.private_preferences;
create trigger private_preferences_mark_complete
before update on public.private_preferences
for each row execute function public.mark_matching_preferences_complete();

create or replace function public.profile_is_ready_for_matching(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(trim(first_name), '') is not null
    and nullif(trim(city), '') is not null
    and nullif(trim(country), '') is not null
    and length(trim(bio)) >= 40
    and cardinality(photos) >= 1,
    false
  )
  and exists (
    select 1 from private_preferences pp
    where pp.user_id = p_user_id
      and pp.matching_preferences_completed_at is not null
  )
  from profiles where id = p_user_id;
$$;

create or replace function public.get_my_profile_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select jsonb_build_object(
    'ready', profile_is_ready_for_matching(auth.uid()),
    'missing', to_jsonb(array_remove(array[
      case when nullif(trim(p.first_name), '') is null then 'name' end,
      case when nullif(trim(p.city), '') is null or nullif(trim(p.country), '') is null then 'location' end,
      case when length(trim(p.bio)) < 40 then 'bio' end,
      case when cardinality(p.photos) < 1 then 'photo' end,
      case when not exists (
        select 1 from private_preferences pp
        where pp.user_id = p.id and pp.matching_preferences_completed_at is not null
      ) then 'preferences' end
    ], null))
  )
  from profiles p where p.id = auth.uid();
$$;

create or replace function public.get_current_round()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  r rounds%rowtype;
  cards jsonb;
begin
  if auth.uid() is null or not profile_is_ready_for_matching(auth.uid()) then
    return null;
  end if;

  select * into r
  from rounds
  where user_id = auth.uid()
    and submitted_at is null
    and expires_at > now()
  order by opens_at desc
  limit 1;

  if r is null then return null; end if;

  select coalesce(jsonb_agg(card order by card->>'id'), '[]'::jsonb) into cards
  from (
    select jsonb_build_object(
      'id', i.id,
      'roundId', i.round_id,
      'agreements', i.agreements,
      'profile', safe_member_profile(p)
    ) as card
    from introductions i
    join profiles p on p.id = i.subject_id
    where i.round_id = r.id and i.viewer_id = auth.uid()
  ) cards_q;

  return jsonb_build_object(
    'id', r.id,
    'opensAt', r.opens_at,
    'expiresAt', r.expires_at,
    'tier', r.tier,
    'submitted', false,
    'introductions', cards
  );
end;
$$;

create or replace function public.generate_round_for_pairs(p_expires_at timestamptz)
returns int
language plpgsql security definer set search_path = public, halal_mode_private as $$
declare pair record; round_a uuid; round_b uuid; intro_a uuid; intro_b uuid; created int := 0;
begin
  insert into rounds (user_id, tier, expires_at)
  select p.id, p.tier, p_expires_at from profiles p
  where p.onboarding_complete and not p.is_paused and profile_is_ready_for_matching(p.id)
    and not exists (select 1 from rounds r where r.user_id = p.id and r.submitted_at is null);

  for pair in
    with eligible as (
      select p.id, p.gender, p.tier, coalesce(s.band, 3) as band
      from profiles p left join selection_scores s on s.user_id = p.id
      where p.onboarding_complete and not p.is_paused and profile_is_ready_for_matching(p.id)
    ), candidates as (
      select m.id as male_id, f.id as female_id, abs(m.band - f.band) as band_gap, random() as jitter
      from eligible m join eligible f on f.gender = 'female'
      where m.gender = 'male' and abs(m.band - f.band) <= 1
        and passes_criteria(m.id, f.id) and passes_criteria(f.id, m.id)
        and not exists (select 1 from introductions i where (i.viewer_id = m.id and i.subject_id = f.id) or (i.viewer_id = f.id and i.subject_id = m.id))
    ), ranked as (
      select *, row_number() over (partition by male_id order by band_gap, jitter) as male_rank,
        row_number() over (partition by female_id order by band_gap, jitter) as female_rank from candidates
    )
    select r.male_id, r.female_id from ranked r join eligible em on em.id = r.male_id join eligible ef on ef.id = r.female_id
    where r.male_rank <= (select introductions from tier_limits(em.tier)) and r.female_rank <= (select introductions from tier_limits(ef.tier))
  loop
    select id into round_a from rounds where user_id = pair.male_id and submitted_at is null limit 1;
    select id into round_b from rounds where user_id = pair.female_id and submitted_at is null limit 1;
    continue when round_a is null or round_b is null;
    insert into introductions (round_id, viewer_id, subject_id, agreements) values (round_a, pair.male_id, pair.female_id, agreement_summary(pair.male_id, pair.female_id)) on conflict (round_id, subject_id) do nothing returning id into intro_a;
    insert into introductions (round_id, viewer_id, subject_id, agreements) values (round_b, pair.female_id, pair.male_id, agreement_summary(pair.female_id, pair.male_id)) on conflict (round_id, subject_id) do nothing returning id into intro_b;
    if intro_a is not null and intro_b is not null then
      update introductions set reciprocal_id = intro_b where id = intro_a;
      update introductions set reciprocal_id = intro_a where id = intro_b;
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;

revoke all on function public.profile_is_ready_for_matching(uuid) from public, anon, authenticated;
revoke all on function public.generate_round_for_pairs(timestamptz) from public, anon, authenticated;
revoke all on function public.mark_matching_preferences_complete() from public, anon, authenticated;
revoke all on function public.get_my_profile_readiness() from public, anon;
revoke all on function public.get_current_round() from public, anon;
grant execute on function public.generate_round_for_pairs(timestamptz) to service_role;
grant execute on function public.get_my_profile_readiness() to authenticated;
grant execute on function public.get_current_round() to authenticated;
