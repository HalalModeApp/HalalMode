begin;

set local search_path = public, extensions;
select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000361', 'device-first@example.test'),
  ('00000000-0000-0000-0000-000000000362', 'device-second@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000361', 'First', 'First', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000362', 'Second', 'Second', '1990-01-01', 'male', true);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000361","role":"authenticated"}', true);
end $$;
select lives_ok(
  $$ select register_my_notification_device(repeat('z', 32), 'android', 'en') $$,
  'the first member can register a device token'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000362","role":"authenticated"}', true);
end $$;
select lives_ok(
  $$ select register_my_notification_device(repeat('z', 32), 'android', 'ar') $$,
  'a later sign-in can take ownership of the same device token'
);
select is(
  (select count(*)::integer from halal_mode_private.notification_devices
    where platform = 'android' and token_hash = encode(digest(repeat('z', 32), 'sha256'), 'hex')),
  1,
  'a device token has exactly one registration'
);
select is(
  (select user_id from halal_mode_private.notification_devices
    where platform = 'android' and token_hash = encode(digest(repeat('z', 32), 'sha256'), 'hex')),
  '00000000-0000-0000-0000-000000000362'::uuid,
  'the device belongs to the member who most recently enabled it'
);
select is((select get_my_notification_consent()), true, 'the current owner has notification consent');

select * from finish();
rollback;
