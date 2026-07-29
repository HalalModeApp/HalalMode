-- Onboarding location is device-derived, not a free-text self-report. Exact
-- coordinates remain private and are used only by server-side distance rules.
drop function if exists public.complete_onboarding(text, text, date, text, text, text);
drop function if exists public.complete_onboarding(text, text, date, text, text, text, text, text);

create function public.complete_onboarding(
  p_name text, p_first_name text, p_birth_date date, p_gender text,
  p_city text, p_country text, p_latitude double precision, p_longitude double precision,
  p_terms_version text default null, p_privacy_version text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
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
  if p_terms_version is not null and p_privacy_version is not null then
    insert into halal_mode_private.member_legal_consents (user_id, terms_version, privacy_version)
    values (v_user_id, p_terms_version, p_privacy_version)
    on conflict (user_id) do update set terms_version = excluded.terms_version, privacy_version = excluded.privacy_version, accepted_at = now();
  end if;
end;
$$;

revoke all on function public.complete_onboarding(text, text, date, text, text, text, double precision, double precision, text, text) from public, anon;
grant execute on function public.complete_onboarding(text, text, date, text, text, text, double precision, double precision, text, text) to authenticated;
