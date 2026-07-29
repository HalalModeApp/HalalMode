begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('authenticated', 'public.register_my_notification_device(text,text,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.disable_my_notifications()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_my_notification_consent()', 'EXECUTE'),
  'members can manage only their own notification consent through RPCs'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.notification_devices', 'SELECT'),
  'members cannot read raw notification-device records'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000341', 'notifications@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000341', 'Notify', 'Notify', '1990-01-01', 'female', true);
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000341","role":"authenticated"}', true);
end $$;

select lives_ok($$ select register_my_notification_device(repeat('a', 32), 'android', 'en') $$, 'a member can register an Android device token');
select is((select get_my_notification_consent()), true, 'registered device enables consent');
select lives_ok($$ select disable_my_notifications() $$, 'a member can withdraw notification consent');

select * from finish();
rollback;
