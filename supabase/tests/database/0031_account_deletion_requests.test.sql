begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('authenticated', 'public.request_my_account_deletion()', 'EXECUTE')
  and not has_table_privilege('authenticated', 'halal_mode_private.account_deletion_requests', 'SELECT'),
  'members may request but cannot inspect deletion records'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000311', 'deletion-a@example.test'),
  ('00000000-0000-0000-0000-000000000312', 'deletion-b@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000311', 'Deletion A', 'Deletion', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000312', 'Deletion B', 'Deletion', '1990-01-01', 'male', true);
insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000000313', '00000000-0000-0000-0000-000000000311', '00000000-0000-0000-0000-000000000312', 'open');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000311","role":"authenticated"}', true);
end $$;

select lives_ok($$ select request_my_account_deletion() $$, 'a member can request their own deletion');
select is((select is_paused from profiles where id = '00000000-0000-0000-0000-000000000311'), true, 'the requesting profile is immediately paused');
select is((select stage::text from connections where id = '00000000-0000-0000-0000-000000000313'), 'closed', 'open conversations close immediately');
select is((select count(*)::int from halal_mode_private.account_deletion_requests where user_id = '00000000-0000-0000-0000-000000000311'), 1, 'the server records exactly one deletion request');

select * from finish();
rollback;
