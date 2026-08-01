-- Let the preferences RPC carry the new criteria.
--
-- 0038 made this function the only way a member may write their preferences,
-- with an explicit key allowlist so an unexpected column can never be set from
-- a client. That boundary is doing its job here: without this migration, sect,
-- children and must-have would all be rejected as server-controlled fields.
--
-- The whole function is restated rather than patched, because the allowlist and
-- the validations have to move together — a key admitted at the top with no
-- matching check below is exactly the hole 0038 exists to prevent.
--
-- Every existing field keeps its original bounds unchanged.

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
  v_family family_goals[]; v_sects sect[];
  v_must_have jsonb; v_bad_criterion text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'Preference changes must be an object' using errcode = '22023'; end if;

  select key into v_unknown_key from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in (
    'min_age', 'max_age', 'min_height_cm', 'max_height_cm', 'preferred_builds',
    'preferred_countries', 'max_distance_km', 'preferred_practice', 'desired_timeline',
    'own_height_cm', 'own_weight_kg', 'own_build',
    'desired_family_goals', 'preferred_sects', 'must_have'
  ) limit 1;
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

  -- New: what the member hopes for in children. family_goals has existed on
  -- profiles since the beginning and was used nowhere in matching, despite
  -- being the kind of difference that ends a marriage rather than complicates
  -- one.
  if p_patch ? 'desired_family_goals' then
    if jsonb_typeof(p_patch->'desired_family_goals') <> 'array' or jsonb_array_length(p_patch->'desired_family_goals') > 4 then raise exception 'Children choices are invalid' using errcode = '22023'; end if;
    select coalesce(array_agg(value::family_goals order by value::family_goals), '{}') into v_family from jsonb_array_elements_text(p_patch->'desired_family_goals') as family_values(value);
  else v_family := v_current.desired_family_goals; end if;

  -- New: sect.
  if p_patch ? 'preferred_sects' then
    if jsonb_typeof(p_patch->'preferred_sects') <> 'array' or jsonb_array_length(p_patch->'preferred_sects') > 4 then raise exception 'Sect choices are invalid' using errcode = '22023'; end if;
    select coalesce(array_agg(value::sect order by value::sect), '{}') into v_sects from jsonb_array_elements_text(p_patch->'preferred_sects') as sect_values(value);
    -- 'prefer_not_to_say' describes a member, not a requirement anyone can place
    -- on a partner. Accepting it would let a filter exclude everyone who did
    -- declare, which inverts what the value means.
    if 'prefer_not_to_say' = any (v_sects) then raise exception 'A sect preference cannot require an unstated sect' using errcode = '22023'; end if;
  else v_sects := v_current.preferred_sects; end if;

  -- New: which criteria this member treats as absolute. Keys are checked against
  -- the criteria the matcher understands and values must be genuine booleans, so
  -- a malformed map can never silently narrow somebody's pool.
  if p_patch ? 'must_have' then
    if jsonb_typeof(p_patch->'must_have') <> 'object' then raise exception 'Must-have choices must be an object' using errcode = '22023'; end if;
    select key into v_bad_criterion
    from jsonb_object_keys(p_patch->'must_have') as criteria(key)
    where key not in ('age', 'height', 'build', 'distance', 'practice', 'timeline', 'children', 'sect')
       or jsonb_typeof(p_patch->'must_have'->key) <> 'boolean'
    limit 1;
    if v_bad_criterion is not null then raise exception 'Unsupported must-have criterion: %', v_bad_criterion using errcode = '22023'; end if;
    v_must_have := p_patch->'must_have';
  else v_must_have := v_current.must_have; end if;

  update private_preferences set
    min_age = v_min_age, max_age = v_max_age, min_height_cm = v_min_height, max_height_cm = v_max_height,
    preferred_builds = v_builds, preferred_countries = v_countries, max_distance_km = v_distance,
    preferred_practice = v_practice, desired_timeline = v_timeline, own_height_cm = v_own_height,
    own_weight_kg = v_own_weight, own_build = v_own_build,
    desired_family_goals = v_family, preferred_sects = v_sects, must_have = v_must_have,
    updated_at = now()
  where user_id = auth.uid();
end;
$$;

revoke all on function public.update_my_private_preferences(jsonb) from public, anon;
grant execute on function public.update_my_private_preferences(jsonb) to authenticated;
