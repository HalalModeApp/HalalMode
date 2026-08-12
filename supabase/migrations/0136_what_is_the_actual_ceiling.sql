-- What the statement timeout actually is, and how big the shortlist actually is.
--
-- The previous probe timed out measuring, which is itself the finding: the
-- ceiling is lower than the sixty seconds assumed from the ALTER FUNCTION
-- settings. Two numbers, each cheap enough that neither can time out.

create or replace function public.current_ceiling_service()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Requires service role' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'statement_timeout', current_setting('statement_timeout', true),
    'lock_timeout', current_setting('lock_timeout', true),
    'role', current_user
  );
end;
$$;

create or replace function public.shortlist_size_service(p_per_member integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set statement_timeout = '110s'
as $$
declare
  v_t timestamptz := clock_timestamp();
  v_pairs bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Requires service role' using errcode = '42501';
  end if;
  select count(*) into v_pairs from (
    select 1 from (
      select row_number() over (partition by m.id order by abs(m.age - f.age), f.id) hr,
             row_number() over (partition by f.id order by abs(m.age - f.age), m.id) hr2
      from halal_mode_private.matching_pool m
      join halal_mode_private.matching_pool f on f.gender = 'female'
      where m.gender = 'male'
    ) r where r.hr <= p_per_member or r.hr2 <= p_per_member
  ) s;
  return jsonb_build_object(
    'per_member', p_per_member,
    'shortlisted_pairs', v_pairs,
    'ms', round(extract(epoch from (clock_timestamp() - v_t)) * 1000)
  );
end;
$$;

revoke all on function public.current_ceiling_service() from public, anon, authenticated;
revoke all on function public.shortlist_size_service(integer) from public, anon, authenticated;
grant execute on function public.current_ceiling_service() to service_role;
grant execute on function public.shortlist_size_service(integer) to service_role;
