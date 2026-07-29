-- Private matching preferences influence who is introduced, so members may
-- change only a reviewed subset through a validating RPC. Raw table access is
-- removed even for the owner to keep the matching contract server-controlled.

revoke all on table public.private_preferences from public, anon, authenticated;
drop policy if exists "own preferences only" on public.private_preferences;

create or replace function public.get_my_private_preferences()
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare v_preferences private_preferences%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into v_preferences from private_preferences where user_id = auth.uid();
  if v_preferences is null then raise exception 'Private preferences were not found' using errcode = 'P0002'; end if;
  return to_jsonb(v_preferences) - 'user_id' - 'updated_at';
end;
$$;

create or replace function public.update_my_private_preferences(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_unknown_key text;
  v_current private_preferences%rowtype;
  v_min_age int; v_max_age int; v_min_height int; v_max_height int;
  v_distance int; v_own_height int; v_own_weight int;
  v_builds text[]; v_countries text[];
  v_practice religious_practice[]; v_timeline marriage_timeline[];
  v_own_build text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Preference changes must be an object' using errcode = '22023'; end if;

  select key into v_unknown_key from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in ('min_age', 'max_age', 'min_height_cm', 'max_height_cm', 'preferred_builds', 'preferred_countries', 'max_distance_km', 'preferred_practice', 'desired_timeline', 'own_height_cm', 'own_weight_kg', 'own_build') limit 1;
  if v_unknown_key is not null then raise exception 'Preference field is server controlled: %', v_unknown_key using errcode = '42501'; end if;

  select * into v_current from private_preferences where user_id = auth.uid() for update;
  if v_current is null then raise exception 'Private preferences were not found' using errcode = 'P0002'; end if;

  v_min_age := case when p_patch ? 'min_age' then (p_patch->>'min_age')::int else v_current.min_age end;
  v_max_age := case when p_patch ? 'max_age' then (p_patch->>'max_age')::int else v_current.max_age end;
  v_min_height := case when p_patch ? 'min_height_cm' then (p_patch->>'min_height_cm')::int else v_current.min_height_cm end;
  v_max_height := case when p_patch ? 'max_height_cm' then (p_patch->>'max_height_cm')::int else v_current.max_height_cm end;
  v_distance := case when p_patch ? 'max_distance_km' then (p_patch->>'max_distance_km')::int else v_current.max_distance_km end;
  v_own_height := case when p_patch ? 'own_height_cm' then nullif(p_patch->>'own_height_cm', '')::int else v_current.own_height_cm end;
  v_own_weight := case when p_patch ? 'own_weight_kg' then nullif(p_patch->>'own_weight_kg', '')::int else v_current.own_weight_kg end;
  v_own_build := case when p_patch ? 'own_build' then nullif(left(trim(p_patch->>'own_build'), 60), '') else v_current.own_build end;

  if v_min_age not between 18 and 70 or v_max_age not between 18 and 70 or v_min_age > v_max_age then raise exception 'Age range must be between 18 and 70' using errcode = '22023'; end if;
  if v_min_height not between 140 and 210 or v_max_height not between 140 and 210 or v_min_height > v_max_height then raise exception 'Height range must be between 140 and 210 cm' using errcode = '22023'; end if;
  if v_distance not between 10 and 500 then raise exception 'Distance must be between 10 and 500 km' using errcode = '22023'; end if;
  if v_own_height is not null and v_own_height not between 140 and 210 then raise exception 'Your height must be between 140 and 210 cm' using errcode = '22023'; end if;
  if v_own_weight is not null and v_own_weight not between 30 and 300 then raise exception 'Your weight must be between 30 and 300 kg' using errcode = '22023'; end if;

  if p_patch ? 'preferred_builds' then
    if jsonb_typeof(p_patch->'preferred_builds') <> 'array' or jsonb_array_length(p_patch->'preferred_builds') > 24 then raise exception 'Choose at most 24 body descriptions' using errcode = '22023'; end if;
    select coalesce(array_agg(value order by value), '{}') into v_builds from (select distinct trim(value) as value from jsonb_array_elements_text(p_patch->'preferred_builds') as build_values(value) where length(trim(value)) between 1 and 60) as unique_values;
    if coalesce(array_length(v_builds, 1), 0) <> jsonb_array_length(p_patch->'preferred_builds') then raise exception 'Body descriptions are invalid' using errcode = '22023'; end if;
  else v_builds := v_current.preferred_builds; end if;

  if p_patch ? 'preferred_countries' then
    if jsonb_typeof(p_patch->'preferred_countries') <> 'array' or jsonb_array_length(p_patch->'preferred_countries') > 200 then raise exception 'Choose at most 200 countries' using errcode = '22023'; end if;
    select coalesce(array_agg(value order by value), '{}') into v_countries from (select distinct trim(value) as value from jsonb_array_elements_text(p_patch->'preferred_countries') as country_values(value) where length(trim(value)) between 2 and 100) as unique_values;
    if coalesce(array_length(v_countries, 1), 0) <> jsonb_array_length(p_patch->'preferred_countries') then raise exception 'Countries are invalid' using errcode = '22023'; end if;
  else v_countries := v_current.preferred_countries; end if;

  if p_patch ? 'preferred_practice' then
    if jsonb_typeof(p_patch->'preferred_practice') <> 'array' or jsonb_array_length(p_patch->'preferred_practice') > 4 then raise exception 'Religious practice choices are invalid' using errcode = '22023'; end if;
    select coalesce(array_agg(value::religious_practice order by value::religious_practice), '{}') into v_practice from jsonb_array_elements_text(p_patch->'preferred_practice') as practice_values(value);
  else v_practice := v_current.preferred_practice; end if;

  if p_patch ? 'desired_timeline' then
    if jsonb_typeof(p_patch->'desired_timeline') <> 'array' or jsonb_array_length(p_patch->'desired_timeline') > 4 then raise exception 'Marriage timing choices are invalid' using errcode = '22023'; end if;
    select coalesce(array_agg(value::marriage_timeline order by value::marriage_timeline), '{}') into v_timeline from jsonb_array_elements_text(p_patch->'desired_timeline') as timeline_values(value);
  else v_timeline := v_current.desired_timeline; end if;

  update private_preferences set
    min_age = v_min_age, max_age = v_max_age, min_height_cm = v_min_height, max_height_cm = v_max_height,
    preferred_builds = v_builds, preferred_countries = v_countries, max_distance_km = v_distance,
    preferred_practice = v_practice, desired_timeline = v_timeline, own_height_cm = v_own_height,
    own_weight_kg = v_own_weight, own_build = v_own_build, updated_at = now()
  where user_id = auth.uid();
end;
$$;

revoke all on function public.get_my_private_preferences() from public, anon;
revoke all on function public.update_my_private_preferences(jsonb) from public, anon;
grant execute on function public.get_my_private_preferences() to authenticated;
grant execute on function public.update_my_private_preferences(jsonb) to authenticated;
