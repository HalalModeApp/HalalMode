-- Put back the media guard that 0064 removed.
--
-- 0055 exists because this boundary was broken once already — its name says so.
-- It added an early rejection to update_my_profile: a patch naming photos or
-- audio is refused outright, because profile media goes through the media
-- service, where it can be validated and stored privately.
--
-- 0064 restated the whole function to add `sect`, and in doing so dropped that
-- block. The restatement was written against the function's shape rather than
-- against what the shape was protecting, and nothing complained because the
-- test that would have is only run by CI, which had not run in 23 commits.
--
-- Not an open door. The trigger on profiles still refuses the write unless the
-- media RPC has set app.profile_media_rpc, so the column never actually
-- changed. What was lost is the outer layer of a deliberate defence in depth,
-- and a clear error at the point of the mistake: a member patching photos got
-- "server controlled" from a trigger instead of being told where media goes.
--
-- Restated from 0064's own body with the guard spliced back in, so `sect` and
-- everything else 0064 added is preserved exactly.

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

  -- Media never travels through a generic profile patch. The media service is
  -- the only writer, and the trigger on profiles enforces that regardless; this
  -- is the layer that says so plainly, at the point the mistake is made.
  if p_patch ?| array['photos', 'audio_greeting_url', 'audio_duration_seconds'] then
    raise exception 'Profile media must use the media service' using errcode = '42501';
  end if;

  select key into v_unknown_key
  from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in (
    'name', 'first_name', 'occupation', 'education',
    'bio', 'photos', 'chips', 'religious_practice', 'timeline',
    'relocation', 'family_goals', 'languages_spoken',
    'sect'
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
      -- Self-declared, and shown on the profile. The cast fails closed on an
      -- unrecognised value rather than defaulting to a sect nobody chose.
      sect = case when p_patch ? 'sect' then (p_patch->>'sect')::sect else sect end,
      languages_spoken = case when p_patch ? 'languages_spoken' then v_languages else languages_spoken end,
      audio_greeting_url = case when p_patch ? 'audio_greeting_url' then nullif(p_patch->>'audio_greeting_url', '') else audio_greeting_url end,
      audio_duration_seconds = case when p_patch ? 'audio_duration_seconds' then (p_patch->>'audio_duration_seconds')::int else audio_duration_seconds end,
      updated_at = now()
  where id = auth.uid();

  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.update_my_profile(jsonb) from public, anon;
grant execute on function public.update_my_profile(jsonb) to authenticated;

do $$
begin
  assert position('Profile media must use the media service' in
    pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) > 0,
    'the media guard must be back in update_my_profile';
  assert position('?|' in
    pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) > 0,
    'the guard must reject the media keys, not merely mention them';
  -- 0064's addition must survive the restatement.
  assert position('sect' in
    pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) > 0,
    'sect must still be an editable field';
end;
$$;
