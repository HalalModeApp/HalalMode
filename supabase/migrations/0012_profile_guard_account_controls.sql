create or replace function guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
     and coalesce(current_setting('app.account_control_rpc', true), '') <> 'true'
     and (
       new.tier is distinct from old.tier
       or new.is_verified is distinct from old.is_verified
       or new.onboarding_complete is distinct from old.onboarding_complete
       or new.is_paused is distinct from old.is_paused
     ) then
    raise exception 'Profile field is server controlled' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
