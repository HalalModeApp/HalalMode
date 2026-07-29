-- The Fajr scheduler is an internal service caller, not a member-facing RPC.
-- Matching fails closed when a same-country distance preference cannot be
-- evaluated from complete coordinates.

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
     and (s_prefs.own_height_cm < v.min_height_cm or s_prefs.own_height_cm > v.max_height_cm) then return false; end if;
  if array_length(v.preferred_builds, 1) is not null and s_prefs.own_build is not null
     and not (s_prefs.own_build = any (v.preferred_builds)) then return false; end if;
  if array_length(v.preferred_practice, 1) is not null and s.religious_practice is not null
     and not (s.religious_practice = any (v.preferred_practice)) then return false; end if;
  if array_length(v.desired_timeline, 1) is not null and s.timeline is not null
     and not (s.timeline = any (v.desired_timeline)) then return false; end if;
  if not halal_mode_private.accepts_subject_country(p_viewer, p_subject) then return false; end if;

  if lower(trim(vp.country)) = lower(trim(s.country)) then
    if vp.latitude is null or vp.longitude is null or s.latitude is null or s.longitude is null then
      return false;
    end if;
    if distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude) > v.max_distance_km then
      return false;
    end if;
  end if;

  if exists (
    select 1 from blocks
    where (blocker_id = p_viewer and blocked_id = p_subject)
       or (blocker_id = p_subject and blocked_id = p_viewer)
  ) then return false; end if;
  return true;
end;
$$;

revoke all on function passes_criteria(uuid, uuid) from public, anon, authenticated;
grant execute on function generate_round_for_pairs(timestamptz) to service_role;
grant execute on function expire_stale_rounds() to service_role;
