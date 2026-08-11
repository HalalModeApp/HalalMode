-- One command to remove every test account.
--
-- Beta preparation needs a real cohort — enough people to build a round, send
-- interest, and exercise the parts of this system that only appear with data.
-- Those accounts must not still be here when real members arrive, and deleting
-- them by hand is exactly the chore that gets half done.
--
-- Scoped to one domain and nothing else. Every seeded account is
-- @halalmodetest.com and nothing real ever will be, so the address is the whole
-- safety mechanism: the function cannot be pointed at anybody, because it takes
-- no argument saying who to delete.
--
-- Consent history is append-only, and the cascade from auth.users reaches it,
-- so the guard comes off for the length of the delete and is asserted back
-- afterwards. DISABLE TRIGGER holds an ACCESS EXCLUSIVE lock, so nothing else
-- can write to that table while it is down.

create or replace function public.purge_test_accounts_service(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_domain constant text := '@halalmodetest.com';
  v_ids uuid[];
  v_profiles int;
  v_left int;
begin
  if auth.uid() is not null then
    raise exception 'Not available' using errcode = '42501';
  end if;
  -- Deliberately awkward. A destructive call should not be one typo away from a
  -- read-only one, and there is no sensible default for this argument.
  if p_confirm is distinct from 'delete every test account' then
    raise exception 'Pass the exact confirmation phrase to purge test accounts'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(id), '{}') into v_ids
  from auth.users where email like '%' || v_domain;

  if cardinality(v_ids) = 0 then
    return jsonb_build_object('deleted', 0, 'note', 'no test accounts found');
  end if;

  -- Belt and braces: if anything without the test domain reached this array,
  -- stop rather than delete it. The query above cannot produce that, which is
  -- the point — this catches a future edit to the query, not today's bug.
  if exists (
    select 1 from auth.users
    where id = any(v_ids) and email not like '%' || v_domain
  ) then
    raise exception 'refusing to delete an account outside the test domain';
  end if;

  select count(*) into v_profiles from public.profiles where id = any(v_ids);

  alter table halal_mode_private.member_legal_consent_history
    disable trigger member_legal_consent_history_append_only;

  -- pair_exposure and member_hides key on member ids without a cascade, so they
  -- are cleared explicitly; everything else follows auth.users down.
  delete from halal_mode_private.member_hides
   where hider_id = any(v_ids) or hidden_id = any(v_ids);
  delete from halal_mode_private.pair_exposure
   where user_low = any(v_ids) or user_high = any(v_ids);
  delete from auth.users where id = any(v_ids);

  alter table halal_mode_private.member_legal_consent_history
    enable trigger member_legal_consent_history_append_only;

  select count(*) into v_left from public.profiles where id = any(v_ids);
  assert v_left = 0, format('%s test profiles survived the purge', v_left);
  assert (
    select tgenabled from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'halal_mode_private'
      and c.relname = 'member_legal_consent_history'
      and t.tgname = 'member_legal_consent_history_append_only'
  ) = 'O', 'the append-only guard must be restored before this returns';

  return jsonb_build_object(
    'deleted', cardinality(v_ids),
    'profiles_removed', v_profiles,
    'domain', v_domain
  );
end;
$$;

comment on function public.purge_test_accounts_service(text) is
  'Removes every @halalmodetest.com account and everything hanging off it. Takes no target: the domain is hard-coded, so it cannot be aimed at a real member. Service role only, and requires the exact phrase "delete every test account".';

revoke all on function public.purge_test_accounts_service(text)
  from public, anon, authenticated;
grant execute on function public.purge_test_accounts_service(text) to service_role;

do $$
declare
  v_raised boolean := false;
begin
  -- The confirmation is load-bearing, so check it actually refuses.
  begin
    perform public.purge_test_accounts_service('yes');
  exception when sqlstate '22023' then v_raised := true;
  end;
  assert v_raised, 'the wrong phrase must refuse rather than delete';

  assert not has_function_privilege(
    'authenticated', 'public.purge_test_accounts_service(text)', 'EXECUTE'
  ), 'no member may call this';
  assert not has_function_privilege(
    'anon', 'public.purge_test_accounts_service(text)', 'EXECUTE'
  ), 'nor anyone without an account';
end;
$$;
