-- A member's own location is device-derived. The general profile patch can no
-- longer alter place labels, while this dedicated RPC updates labels and exact
-- private coordinates together in one transaction.

create or replace function public.update_my_profile(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_unknown_key text;
  v_photos text[];
  v_chips text[];
  v_languages text[];
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Profile changes must be an object' using errcode = '22023';
  end if;

  select key into v_unknown_key
  from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in (
    'name', 'first_name', 'occupation', 'education',
    'bio', 'photos', 'chips', 'religious_practice', 'timeline',
    'relocation', 'family_goals', 'languages_spoken',
    'audio_greeting_url', 'audio_duration_seconds'
  )
  limit 1;
  if v_unknown_key is not null then
    raise exception 'Profile field is server controlled: %', v_unknown_key
      using errcode = '42501';
  end if;

  if p_patch ? 'photos' then
    if jsonb_typeof(p_patch->'photos') <> 'array' or jsonb_array_length(p_patch->'photos') > 6 then
      raise exception 'Choose at most six photos' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_photos
    from jsonb_array_elements_text(p_patch->'photos') as photo_values(value);
  end if;
  if p_patch ? 'chips' then
    if jsonb_typeof(p_patch->'chips') <> 'array' or jsonb_array_length(p_patch->'chips') > 12 then
      raise exception 'Choose at most twelve profile details' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_chips
    from jsonb_array_elements_text(p_patch->'chips') as chip_values(value);
  end if;
  if p_patch ? 'languages_spoken' then
    if jsonb_typeof(p_patch->'languages_spoken') <> 'array' or jsonb_array_length(p_patch->'languages_spoken') > 12 then
      raise exception 'Choose at most twelve languages' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_languages
    from jsonb_array_elements_text(p_patch->'languages_spoken') as language_values(value);
  end if;

  if p_patch ? 'name' and length(trim(p_patch->>'name')) not between 2 and 100 then
    raise exception 'Name must be between 2 and 100 characters' using errcode = '22023';
  end if;
  if p_patch ? 'first_name' and length(trim(p_patch->>'first_name')) not between 1 and 60 then
    raise exception 'First name must be between 1 and 60 characters' using errcode = '22023';
  end if;
  if p_patch ? 'bio' and length(p_patch->>'bio') > 2000 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;
  if p_patch ? 'audio_duration_seconds'
     and (p_patch->>'audio_duration_seconds')::int not between 1 and 120 then
    raise exception 'Audio greeting must be between 1 and 120 seconds' using errcode = '22023';
  end if;

  update profiles
  set name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
      first_name = case when p_patch ? 'first_name' then trim(p_patch->>'first_name') else first_name end,
      occupation = case when p_patch ? 'occupation' then left(trim(p_patch->>'occupation'), 120) else occupation end,
      education = case when p_patch ? 'education' then nullif(left(trim(p_patch->>'education'), 160), '') else education end,
      bio = case when p_patch ? 'bio' then p_patch->>'bio' else bio end,
      photos = case when p_patch ? 'photos' then v_photos else photos end,
      chips = case when p_patch ? 'chips' then v_chips else chips end,
      religious_practice = case when p_patch ? 'religious_practice' then (p_patch->>'religious_practice')::religious_practice else religious_practice end,
      timeline = case when p_patch ? 'timeline' then (p_patch->>'timeline')::marriage_timeline else timeline end,
      relocation = case when p_patch ? 'relocation' then (p_patch->>'relocation')::relocation_preference else relocation end,
      family_goals = case when p_patch ? 'family_goals' then (p_patch->>'family_goals')::family_goals else family_goals end,
      languages_spoken = case when p_patch ? 'languages_spoken' then v_languages else languages_spoken end,
      audio_greeting_url = case when p_patch ? 'audio_greeting_url' then nullif(p_patch->>'audio_greeting_url', '') else audio_greeting_url end,
      audio_duration_seconds = case when p_patch ? 'audio_duration_seconds' then (p_patch->>'audio_duration_seconds')::int else audio_duration_seconds end,
      updated_at = now()
  where id = auth.uid();

  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
     and coalesce(current_setting('app.account_control_rpc', true), '') <> 'true'
     and coalesce(current_setting('app.location_rpc', true), '') <> 'true'
     and (
       new.tier is distinct from old.tier
       or new.is_verified is distinct from old.is_verified
       or new.onboarding_complete is distinct from old.onboarding_complete
       or new.is_paused is distinct from old.is_paused
       or new.birth_date is distinct from old.birth_date
       or new.gender is distinct from old.gender
       or new.city is distinct from old.city
       or new.country is distinct from old.country
       or new.latitude is distinct from old.latitude
       or new.longitude is distinct from old.longitude
     ) then
    raise exception 'Profile field is server controlled' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.update_my_location(
  p_city text,
  p_country text,
  p_latitude double precision,
  p_longitude double precision
) returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_city is null or p_country is null
     or length(trim(p_city)) not between 2 and 100
     or length(trim(p_country)) not between 2 and 100 then
    raise exception 'Device location could not be resolved' using errcode = '22023';
  end if;
  if p_latitude is null or p_longitude is null
     or p_latitude not between -90 and 90
     or p_longitude not between -180 and 180 then
    raise exception 'Device coordinates are invalid' using errcode = '22023';
  end if;

  perform set_config('app.location_rpc', 'true', true);
  update profiles
  set city = trim(p_city),
      country = trim(p_country),
      latitude = p_latitude,
      longitude = p_longitude,
      updated_at = now()
  where id = auth.uid() and onboarding_complete;

  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.update_my_location(text, text, double precision, double precision) from public, anon;
grant execute on function public.update_my_location(text, text, double precision, double precision) to authenticated;

revoke all on function public.update_my_profile(jsonb) from public, anon;
grant execute on function public.update_my_profile(jsonb) to authenticated;
