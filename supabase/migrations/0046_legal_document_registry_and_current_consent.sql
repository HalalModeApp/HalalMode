-- Legal documents are versioned server-side. Consent is append-only history,
-- never a mutable "latest value" owned by a particular app release.

create table if not exists halal_mode_private.legal_document_registry (
  document_type text not null check (document_type in ('terms', 'privacy')),
  version text not null check (length(trim(version)) between 1 and 80),
  title text not null check (length(trim(title)) between 2 and 120),
  effective_date date not null,
  url text not null check (url ~ '^https://'),
  is_current boolean not null default false,
  published_at timestamptz not null default now(),
  primary key (document_type, version)
);

create unique index if not exists legal_document_one_current_per_type
  on halal_mode_private.legal_document_registry (document_type)
  where is_current;

insert into halal_mode_private.legal_document_registry
  (document_type, version, title, effective_date, url, is_current)
values
  ('terms', '2026-07-29', 'Terms of Service', date '2026-07-29', 'https://halalmo.de/terms', true),
  ('privacy', '2026-07-29', 'Privacy Notice', date '2026-07-29', 'https://halalmo.de/privacy', true)
on conflict (document_type, version) do update set
  title = excluded.title,
  effective_date = excluded.effective_date,
  url = excluded.url,
  is_current = true;

create table if not exists halal_mode_private.member_legal_consent_history (
  user_id uuid not null references public.profiles(id) on delete cascade,
  document_type text not null,
  version text not null,
  accepted_at timestamptz not null default now(),
  acceptance_context text not null check (acceptance_context in ('migrated', 'onboarding', 'reacceptance')),
  primary key (user_id, document_type, version),
  foreign key (document_type, version)
    references halal_mode_private.legal_document_registry(document_type, version)
);

insert into halal_mode_private.member_legal_consent_history
  (user_id, document_type, version, accepted_at, acceptance_context)
select old.user_id, versions.document_type, versions.version, old.accepted_at, 'migrated'
from halal_mode_private.member_legal_consents old
cross join lateral (values
  ('terms'::text, old.terms_version),
  ('privacy'::text, old.privacy_version)
) as versions(document_type, version)
on conflict (user_id, document_type, version) do nothing;

drop table halal_mode_private.member_legal_consents;

revoke all on halal_mode_private.legal_document_registry from public, anon, authenticated;
revoke all on halal_mode_private.member_legal_consent_history from public, anon, authenticated;

create or replace function halal_mode_private.member_has_current_legal_consents(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select count(*) = 2
    and bool_and(exists (
      select 1
      from halal_mode_private.member_legal_consent_history h
      where h.user_id = p_user_id
        and h.document_type = d.document_type
        and h.version = d.version
    ))
  from halal_mode_private.legal_document_registry d
  where d.is_current;
$$;

revoke all on function halal_mode_private.member_has_current_legal_consents(uuid)
  from public, anon, authenticated;

create or replace function public.get_my_legal_consent_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v_user_id uuid := auth.uid();
  v_documents jsonb;
  v_document_count int;
begin
  if v_user_id is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select count(*), jsonb_agg(
    jsonb_build_object(
      'type', d.document_type,
      'version', d.version,
      'title', d.title,
      'effectiveDate', d.effective_date,
      'url', d.url
    ) order by d.document_type
  )
  into v_document_count, v_documents
  from halal_mode_private.legal_document_registry d
  where d.is_current;

  if v_document_count <> 2
     or not exists (
       select 1 from halal_mode_private.legal_document_registry
       where document_type = 'terms' and is_current
     )
     or not exists (
       select 1 from halal_mode_private.legal_document_registry
       where document_type = 'privacy' and is_current
     ) then
    raise exception 'Current legal documents are unavailable' using errcode = '55000';
  end if;

  return jsonb_build_object(
    'required', not halal_mode_private.member_has_current_legal_consents(v_user_id),
    'currentDocuments', v_documents
  );
end;
$$;

create or replace function public.accept_current_legal_documents()
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_user_id uuid := auth.uid();
  v_document_count int;
begin
  if v_user_id is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and onboarding_complete
  ) then
    raise exception 'Complete onboarding before accepting updated documents' using errcode = '42501';
  end if;

  select count(*) into v_document_count
  from halal_mode_private.legal_document_registry
  where is_current;
  if v_document_count <> 2 then
    raise exception 'Current legal documents are unavailable' using errcode = '55000';
  end if;

  insert into halal_mode_private.member_legal_consent_history
    (user_id, document_type, version, acceptance_context)
  select v_user_id, d.document_type, d.version, 'reacceptance'
  from halal_mode_private.legal_document_registry d
  where d.is_current
  on conflict (user_id, document_type, version) do nothing;

  return public.get_my_legal_consent_status();
end;
$$;

drop function if exists public.complete_onboarding(
  text, text, date, text, text, text,
  double precision, double precision, text, text
);

create function public.complete_onboarding(
  p_name text, p_first_name text, p_birth_date date, p_gender text,
  p_city text, p_country text, p_latitude double precision, p_longitude double precision,
  p_terms_version text, p_privacy_version text
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_user_id uuid := auth.uid();
  v_terms_version text;
  v_privacy_version text;
begin
  if v_user_id is null then raise exception 'You must be signed in' using errcode = '42501'; end if;

  select version into v_terms_version
  from halal_mode_private.legal_document_registry
  where document_type = 'terms' and is_current;
  select version into v_privacy_version
  from halal_mode_private.legal_document_registry
  where document_type = 'privacy' and is_current;
  if v_terms_version is null or v_privacy_version is null
     or p_terms_version is distinct from v_terms_version
     or p_privacy_version is distinct from v_privacy_version then
    raise exception 'Current legal documents must be accepted' using errcode = '22023';
  end if;

  if exists (select 1 from profiles where id = v_user_id and onboarding_complete) then raise exception 'Onboarding is already complete' using errcode = '42501'; end if;
  if p_name is null or p_first_name is null or length(trim(p_name)) not between 2 and 100 or length(trim(p_first_name)) not between 1 and 60 then raise exception 'Please provide your name' using errcode = '22023'; end if;
  if p_birth_date is null or p_birth_date > current_date - interval '18 years' or p_birth_date < current_date - interval '100 years' then raise exception 'You must be between 18 and 100 years old' using errcode = '22023'; end if;
  if p_gender is null or p_gender not in ('male', 'female') then raise exception 'Choose a gender' using errcode = '22023'; end if;
  if p_city is null or p_country is null or length(trim(p_city)) not between 2 and 100 or length(trim(p_country)) not between 2 and 100 then raise exception 'Device location could not be resolved' using errcode = '22023'; end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then raise exception 'Device coordinates are invalid' using errcode = '22023'; end if;

  perform set_config('app.onboarding_rpc', 'true', true);
  insert into profiles (id, name, first_name, birth_date, gender, city, country, latitude, longitude, onboarding_complete)
  values (v_user_id, trim(p_name), trim(p_first_name), p_birth_date, p_gender::gender, trim(p_city), trim(p_country), p_latitude, p_longitude, true)
  on conflict (id) do update set
    name = excluded.name, first_name = excluded.first_name, birth_date = excluded.birth_date,
    gender = excluded.gender, city = excluded.city, country = excluded.country,
    latitude = excluded.latitude, longitude = excluded.longitude, onboarding_complete = true, updated_at = now()
  where not profiles.onboarding_complete;

  insert into private_preferences (user_id) values (v_user_id) on conflict (user_id) do nothing;
  insert into selection_scores (user_id) values (v_user_id) on conflict (user_id) do nothing;
  insert into halal_mode_private.member_legal_consent_history
    (user_id, document_type, version, acceptance_context)
  select v_user_id, d.document_type, d.version, 'onboarding'
  from halal_mode_private.legal_document_registry d
  where d.is_current
  on conflict (user_id, document_type, version) do nothing;
end;
$$;

create or replace function public.get_current_round()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  r rounds%rowtype;
  cards jsonb;
begin
  if auth.uid() is null
     or not halal_mode_private.member_has_current_legal_consents(auth.uid())
     or not profile_is_ready_for_matching(auth.uid()) then
    return null;
  end if;

  select * into r
  from rounds
  where user_id = auth.uid() and submitted_at is null and expires_at > now()
  order by opens_at desc limit 1;
  if r is null then return null; end if;

  select coalesce(jsonb_agg(card order by card->>'id'), '[]'::jsonb) into cards
  from (
    select jsonb_build_object(
      'id', i.id, 'roundId', i.round_id, 'agreements', i.agreements,
      'profile', safe_member_profile(p)
    ) as card
    from introductions i join profiles p on p.id = i.subject_id
    where i.round_id = r.id and i.viewer_id = auth.uid()
  ) cards_q;

  return jsonb_build_object(
    'id', r.id, 'opensAt', r.opens_at, 'expiresAt', r.expires_at,
    'tier', r.tier, 'submitted', false, 'introductions', cards
  );
end;
$$;

create or replace function public.get_current_round_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  v_member_id uuid := auth.uid();
  v_profile profiles%rowtype;
  v_preferences private_preferences%rowtype;
  v_round jsonb;
begin
  if v_member_id is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if not halal_mode_private.member_has_current_legal_consents(v_member_id) then
    return jsonb_build_object('status', 'legal_consent_required', 'round', null);
  end if;
  if not profile_is_ready_for_matching(v_member_id) then
    return jsonb_build_object('status', 'profile_not_ready', 'round', null);
  end if;

  v_round := get_current_round();
  if v_round is not null and jsonb_array_length(coalesce(v_round->'introductions', '[]'::jsonb)) > 0 then
    return jsonb_build_object('status', 'ready', 'round', v_round);
  end if;

  select * into v_profile from profiles where id = v_member_id;
  select * into v_preferences from private_preferences where user_id = v_member_id;
  if v_profile.latitude is null or v_profile.longitude is null
     or v_profile.latitude not between -90 and 90 or v_profile.longitude not between -180 and 180
     or v_preferences is null or v_preferences.matching_preferences_completed_at is null then
    return jsonb_build_object('status', 'matching_inputs_unavailable', 'round', v_round);
  end if;
  return jsonb_build_object('status', 'no_suitable_introductions', 'round', v_round);
end;
$$;

create or replace function public.generate_round_for_pairs(p_expires_at timestamptz)
returns int
language plpgsql security definer set search_path = public, halal_mode_private as $$
declare pair record; round_a uuid; round_b uuid; intro_a uuid; intro_b uuid; created int := 0;
begin
  insert into rounds (user_id, tier, expires_at)
  select p.id, p.tier, p_expires_at from profiles p
  where p.onboarding_complete and not p.is_paused
    and profile_is_ready_for_matching(p.id)
    and halal_mode_private.member_has_current_legal_consents(p.id)
    and not exists (select 1 from rounds r where r.user_id = p.id and r.submitted_at is null);

  for pair in
    with eligible as (
      select p.id, p.gender, p.tier, coalesce(s.band, 3) as band
      from profiles p left join selection_scores s on s.user_id = p.id
      where p.onboarding_complete and not p.is_paused
        and profile_is_ready_for_matching(p.id)
        and halal_mode_private.member_has_current_legal_consents(p.id)
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

revoke all on function public.get_my_legal_consent_status() from public, anon;
revoke all on function public.accept_current_legal_documents() from public, anon;
revoke all on function public.complete_onboarding(text, text, date, text, text, text, double precision, double precision, text, text) from public, anon;
revoke all on function public.get_current_round() from public, anon;
revoke all on function public.get_current_round_state() from public, anon;
revoke all on function public.generate_round_for_pairs(timestamptz) from public, anon, authenticated;

grant execute on function public.get_my_legal_consent_status() to authenticated;
grant execute on function public.accept_current_legal_documents() to authenticated;
grant execute on function public.complete_onboarding(text, text, date, text, text, text, double precision, double precision, text, text) to authenticated;
grant execute on function public.get_current_round() to authenticated;
grant execute on function public.get_current_round_state() to authenticated;
grant execute on function public.generate_round_for_pairs(timestamptz) to service_role;
