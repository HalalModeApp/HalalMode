begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('authenticated', 'public.get_my_blocked_members()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.unblock_my_member(uuid)', 'EXECUTE'),
  'members can manage their own blocks through explicit RPCs'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000331', 'blocker@example.test'),
  ('00000000-0000-0000-0000-000000000332', 'blocked@example.test');
insert into profiles (id, name, first_name, birth_date, gender, city, country, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000331', 'Blocker', 'Blocker', '1990-01-01', 'female', 'Jeddah', 'Saudi Arabia', true),
  ('00000000-0000-0000-0000-000000000332', 'Blocked', 'Blocked', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', true);
insert into blocks (blocker_id, blocked_id) values
  ('00000000-0000-0000-0000-000000000331', '00000000-0000-0000-0000-000000000332');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000331","role":"authenticated"}', true);
end $$;

select is((select jsonb_array_length(get_my_blocked_members())), 1, 'the member can list only their own block');
select is((select get_my_blocked_members()->0->>'firstName'), 'Blocked', 'the block list returns only the safe profile card');
select lives_ok($$ select unblock_my_member('00000000-0000-0000-0000-000000000332') $$, 'the member can remove their own block');
select is((select count(*)::int from blocks where blocker_id = '00000000-0000-0000-0000-000000000331'), 0, 'unblocking removes the owned block');

select * from finish();
rollback;
