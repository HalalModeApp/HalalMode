-- A member can review and reverse only blocks they created. The server returns
-- a deliberately small identity card; reports and other safety metadata stay private.

create or replace function get_my_blocked_members()
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'firstName', p.first_name,
    'city', p.city,
    'country', p.country,
    'blockedAt', b.created_at
  ) order by b.created_at desc), '[]'::jsonb)
  from blocks b
  join profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid();
$$;

create or replace function unblock_my_member(p_blocked_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  delete from blocks
  where blocker_id = auth.uid() and blocked_id = p_blocked_user_id;
  if not found then raise exception 'Blocked member was not found' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function get_my_blocked_members(), unblock_my_member(uuid) from public, anon;
grant execute on function get_my_blocked_members(), unblock_my_member(uuid) to authenticated;
