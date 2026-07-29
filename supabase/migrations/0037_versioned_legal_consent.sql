begin;

create table if not exists halal_mode_private.member_legal_consents (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  terms_version text not null check (terms_version = '2026-07-29'),
  privacy_version text not null check (privacy_version = '2026-07-29'),
  accepted_at timestamptz not null default now()
);
revoke all on halal_mode_private.member_legal_consents from public, anon, authenticated;

drop function if exists public.complete_onboarding(text, text, date, text, text, text);
create function public.complete_onboarding(
  p_name text, p_first_name text, p_birth_date date, p_gender text, p_city text, p_country text,
  p_terms_version text, p_privacy_version text
) returns void language plpgsql security definer set search_path = public, halal_mode_private as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if p_terms_version <> '2026-07-29' or p_privacy_version <> '2026-07-29' then raise exception 'Current legal documents must be accepted' using errcode = '22023'; end if;
  if exists (select 1 from profiles where id = v_user_id and onboarding_complete) then raise exception 'Onboarding is already complete' using errcode = '42501'; end if;
  if p_name is null or p_first_name is null or length(trim(p_name)) not between 2 and 100 or length(trim(p_first_name)) not between 1 and 60 then raise exception 'Please provide your name' using errcode = '22023'; end if;
  if p_birth_date is null or p_birth_date > current_date - interval '18 years' or p_birth_date < current_date - interval '100 years' then raise exception 'You must be between 18 and 100 years old' using errcode = '22023'; end if;
  if p_gender is null or p_gender not in ('male', 'female') then raise exception 'Choose a gender' using errcode = '22023'; end if;
  if p_city is null or p_country is null or length(trim(p_city)) not between 2 and 100 or length(trim(p_country)) not between 2 and 100 then raise exception 'Please provide your city and country' using errcode = '22023'; end if;
  perform set_config('app.onboarding_rpc', 'true', true);
  insert into profiles (id, name, first_name, birth_date, gender, city, country, onboarding_complete)
  values (v_user_id, trim(p_name), trim(p_first_name), p_birth_date, p_gender::gender, trim(p_city), trim(p_country), true)
  on conflict (id) do update set name = excluded.name, first_name = excluded.first_name, birth_date = excluded.birth_date, gender = excluded.gender, city = excluded.city, country = excluded.country, onboarding_complete = true, updated_at = now() where not profiles.onboarding_complete;
  insert into halal_mode_private.member_legal_consents (user_id, terms_version, privacy_version)
  values (v_user_id, p_terms_version, p_privacy_version)
  on conflict (user_id) do update set terms_version = excluded.terms_version, privacy_version = excluded.privacy_version, accepted_at = now();
  insert into private_preferences (user_id) values (v_user_id) on conflict (user_id) do nothing;
  insert into selection_scores (user_id) values (v_user_id) on conflict (user_id) do nothing;
end;
$$;
revoke all on function public.complete_onboarding(text, text, date, text, text, text, text, text) from public, anon;
grant execute on function public.complete_onboarding(text, text, date, text, text, text, text, text) to authenticated;
commit;
