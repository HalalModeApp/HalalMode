begin;

set local search_path = public, extensions;
select plan(9);

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.member_entitlements', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.member_verifications', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.notification_devices', 'SELECT'),
  'members cannot read private entitlement, verification, or device records'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.apply_membership_entitlement(uuid,membership_tier,entitlement_state,text,text,timestamptz)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_my_membership_entitlement()', 'EXECUTE')
  and has_function_privilege('service_role', 'halal_mode_private.apply_membership_entitlement(uuid,membership_tier,entitlement_state,text,text,timestamptz)', 'EXECUTE'),
  'only the safe self-entitlement DTO is member-callable and the provider path is service-only'
);
select is(
  (select count(*)::int from halal_mode_private.release_flags), 6,
  'all high-risk launch features start as explicit disabled flags'
);
select ok(
  (select bool_and(not enabled and rollout_percentage = 0) from halal_mode_private.release_flags),
  'high-risk flags fail closed'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000251', 'entitlement@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000251', 'Entitlement', 'Entitlement', '1990-01-01', 'female', true);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000251","role":"authenticated"}', true);
end $$;
select is(
  get_my_membership_entitlement()->>'tier', 'free',
  'a new member sees only their own default free tier'
);
select throws_ok(
  $$ select halal_mode_private.apply_membership_entitlement('00000000-0000-0000-0000-000000000251', 'premium', 'active', 'test', 'hash', now() + interval '1 day') $$,
  '42501', 'Entitlements require service role',
  'a member cannot grant their own Premium entitlement'
);
select is(
  (select tier::text from profiles where id = '00000000-0000-0000-0000-000000000251'),
  'free',
  'the failed self-grant leaves the profile tier unchanged'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.audit_events', 'SELECT'),
  'audit records are not a member-facing relationship oracle'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.release_flags', 'UPDATE'),
  'members cannot enable experimental functionality'
);

select * from finish();
rollback;
