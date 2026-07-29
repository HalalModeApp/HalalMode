begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('authenticated', 'public.report_connection_member(uuid,text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.block_connection_member(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.block_connection_member(uuid)', 'EXECUTE'),
  'safety RPCs are authenticated-only'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000301', 'safety-a@example.test'),
  ('00000000-0000-0000-0000-000000000302', 'safety-b@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000301', 'Safety A', 'Safety', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000302', 'Safety B', 'Safety', '1990-01-01', 'male', true);
insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302', 'open');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000301","role":"authenticated"}', true);
end $$;

select lives_ok(
  $$ select report_connection_member('00000000-0000-0000-0000-000000000303', 'harassment') $$,
  'a member can report the other person in their connection'
);
select is(
  (select subject_id::text from reports where reporter_id = '00000000-0000-0000-0000-000000000301'),
  '00000000-0000-0000-0000-000000000302',
  'the server derives the other member as report subject'
);
select lives_ok(
  $$ select block_connection_member('00000000-0000-0000-0000-000000000303') $$,
  'a member can block the other person in their connection'
);
select is(
  (select stage::text from connections where id = '00000000-0000-0000-0000-000000000303'), 'closed',
  'blocking closes the connection through the server trigger'
);

select * from finish();
rollback;
