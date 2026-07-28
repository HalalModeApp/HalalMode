-- Allow the tightly scoped onboarding RPC to set its completion flag, while
-- preserving the block on all direct authenticated updates.
create or replace function guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
     and (
       new.tier is distinct from old.tier
       or new.is_verified is distinct from old.is_verified
       or new.onboarding_complete is distinct from old.onboarding_complete
     ) then
    raise exception 'Profile field is server controlled' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
