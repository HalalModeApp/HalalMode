begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.release_flag_members', 'SELECT')
  and has_function_privilege('authenticated', 'public.get_my_release_flags()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'halal_mode_private.set_release_flag(text,boolean,smallint)', 'EXECUTE'),
  'members can read only their evaluated flag DTO'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000291', 'flag-member@example.test'),
  ('00000000-0000-0000-0000-000000000292', 'flag-outsider@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000291', 'Flag Member', 'Flag', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000292', 'Flag Outsider', 'Flag', '1990-01-01', 'male', true);
update halal_mode_private.release_flags set enabled = true, rollout_percentage = 0 where key = 'controlled_beta';
insert into halal_mode_private.release_flag_members (key, user_id)
values ('controlled_beta', '00000000-0000-0000-0000-000000000291');

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000291","role":"authenticated"}', true);
end $$;
select ok(
  (get_my_release_flags()->>'controlled_beta')::boolean,
  'an explicit controlled-beta member is enabled'
);
select ok(
  not (get_my_release_flags()->>'live_calling')::boolean,
  'unconfigured high-risk flags remain off'
);
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000292","role":"authenticated"}', true);
end $$;
select ok(
  not (get_my_release_flags()->>'controlled_beta')::boolean,
  'an outsider is not enabled by a zero-percent rollout'
);
select throws_ok(
  $$ select halal_mode_private.set_release_flag('controlled_beta', true, 100) $$,
  '42501', 'Release flags require service role', 'members cannot change release rollout'
);

select * from finish();
rollback;
