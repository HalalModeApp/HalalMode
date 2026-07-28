-- Account controls that alter matching eligibility are server-side actions,
-- not arbitrary client profile writes.
create or replace function set_my_profile_paused(p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  perform set_config('app.account_control_rpc', 'true', true);
  update profiles
  set is_paused = p_paused, updated_at = now()
  where id = auth.uid();
  if not found then raise exception 'Profile not found'; end if;
end;
$$;

revoke all on function set_my_profile_paused(boolean) from public;
grant execute on function set_my_profile_paused(boolean) to authenticated;
