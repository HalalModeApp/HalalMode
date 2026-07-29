-- Readiness is guidance, not an eligibility gate. Keeping this calculation on
-- the server prevents client versions from disagreeing after a profile is saved.

create or replace function get_my_profile_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select jsonb_build_object(
    'ready',
      nullif(trim(p.first_name), '') is not null
      and nullif(trim(p.city), '') is not null
      and nullif(trim(p.country), '') is not null
      and length(trim(p.bio)) >= 40
      and cardinality(p.photos) >= 1,
    'missing',
      to_jsonb(array_remove(array[
        case when nullif(trim(p.first_name), '') is null then 'name' end,
        case when nullif(trim(p.city), '') is null or nullif(trim(p.country), '') is null then 'location' end,
        case when length(trim(p.bio)) < 40 then 'bio' end,
        case when cardinality(p.photos) < 1 then 'photo' end
      ], null))
  )
  from profiles p
  where p.id = auth.uid();
$$;

revoke all on function get_my_profile_readiness() from public, anon;
grant execute on function get_my_profile_readiness() to authenticated;
