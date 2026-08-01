-- Restore the private-media write boundary lost when migration 0045 replaced
-- the profile updater and trigger. Profile media may change only through the
-- dedicated Storage-backed attachment and deletion RPCs.

create or replace function public.update_my_profile(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_unknown_key text;
  v_chips text[];
  v_languages text[];
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Profile changes must be an object' using errcode = '22023';
  end if;

  if p_patch ?| array['photos', 'audio_greeting_url', 'audio_duration_seconds'] then
    raise exception 'Profile media must use the media service' using errcode = '42501';
  end if;

  select key into v_unknown_key
  from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in (
    'name', 'first_name', 'occupation', 'education', 'bio', 'chips',
    'religious_practice', 'timeline', 'relocation', 'family_goals',
    'languages_spoken'
  )
  limit 1;
  if v_unknown_key is not null then
    raise exception 'Profile field is server controlled: %', v_unknown_key
      using errcode = '42501';
  end if;

  if p_patch ? 'chips' then
    if jsonb_typeof(p_patch->'chips') <> 'array'
       or jsonb_array_length(p_patch->'chips') > 12 then
      raise exception 'Choose at most twelve profile details' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_chips
    from jsonb_array_elements_text(p_patch->'chips') as chip_values(value);
  end if;
  if p_patch ? 'languages_spoken' then
    if jsonb_typeof(p_patch->'languages_spoken') <> 'array'
       or jsonb_array_length(p_patch->'languages_spoken') > 12 then
      raise exception 'Choose at most twelve languages' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_languages
    from jsonb_array_elements_text(p_patch->'languages_spoken') as language_values(value);
  end if;

  if p_patch ? 'name' and length(trim(p_patch->>'name')) not between 2 and 100 then
    raise exception 'Name must be between 2 and 100 characters' using errcode = '22023';
  end if;
  if p_patch ? 'first_name'
     and length(trim(p_patch->>'first_name')) not between 1 and 60 then
    raise exception 'First name must be between 1 and 60 characters' using errcode = '22023';
  end if;
  if p_patch ? 'bio' and length(p_patch->>'bio') > 2000 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;

  update profiles
  set name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
      first_name = case when p_patch ? 'first_name' then trim(p_patch->>'first_name') else first_name end,
      occupation = case when p_patch ? 'occupation' then left(trim(p_patch->>'occupation'), 120) else occupation end,
      education = case when p_patch ? 'education' then nullif(left(trim(p_patch->>'education'), 160), '') else education end,
      bio = case when p_patch ? 'bio' then p_patch->>'bio' else bio end,
      chips = case when p_patch ? 'chips' then v_chips else chips end,
      religious_practice = case when p_patch ? 'religious_practice' then (p_patch->>'religious_practice')::religious_practice else religious_practice end,
      timeline = case when p_patch ? 'timeline' then (p_patch->>'timeline')::marriage_timeline else timeline end,
      relocation = case when p_patch ? 'relocation' then (p_patch->>'relocation')::relocation_preference else relocation end,
      family_goals = case when p_patch ? 'family_goals' then (p_patch->>'family_goals')::family_goals else family_goals end,
      languages_spoken = case when p_patch ? 'languages_spoken' then v_languages else languages_spoken end,
      updated_at = now()
  where id = auth.uid();

  if not found then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    if coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
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

    if coalesce(current_setting('app.profile_media_rpc', true), '') <> 'true'
       and (
         new.photos is distinct from old.photos
         or new.audio_greeting_url is distinct from old.audio_greeting_url
         or new.audio_duration_seconds is distinct from old.audio_duration_seconds
       ) then
      raise exception 'Profile media must use the media service' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.update_my_profile(jsonb) from public, anon;
grant execute on function public.update_my_profile(jsonb) to authenticated;
revoke all on function public.guard_profile_client_update() from public, anon, authenticated;
