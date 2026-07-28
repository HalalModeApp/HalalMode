begin;

set local search_path = public, extensions;
select plan(22);

select ok(
  has_function_privilege('authenticated', 'public.send_message(uuid,text)', 'EXECUTE'),
  'authenticated members can call send_message'
);
select ok(
  not has_function_privilege('anon', 'public.send_message(uuid,text)', 'EXECUTE'),
  'anonymous callers cannot call send_message'
);
select ok(
  not has_table_privilege('authenticated', 'public.messages', 'INSERT')
    and not has_table_privilege('authenticated', 'public.messages', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.messages', 'DELETE'),
  'authenticated clients cannot directly create or alter message rows'
);
select ok(
  has_table_privilege('authenticated', 'public.messages', 'SELECT'),
  'authenticated clients retain RLS-protected message reads'
);
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'messages'
     and policyname = 'messages in own unblocked open connections'),
  1,
  'the unblocked open-connection read policy exists'
);
select ok(
  position('blocks' in coalesce((select qual from pg_policies
    where schemaname = 'public' and tablename = 'messages'
      and policyname = 'messages in own unblocked open connections'), '')) > 0,
  'message reads explicitly check blocks'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000181', 'message-a@example.test'),
  ('00000000-0000-0000-0000-000000000182', 'message-b@example.test'),
  ('00000000-0000-0000-0000-000000000183', 'message-c@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000181', 'Message A', 'A', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000182', 'Message B', 'B', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000000183', 'Message C', 'C', '1990-01-01', 'male', true);

insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000001810', '00000000-0000-0000-0000-000000000181', '00000000-0000-0000-0000-000000000182', 'open'),
  ('00000000-0000-0000-0000-000000001811', '00000000-0000-0000-0000-000000000181', '00000000-0000-0000-0000-000000000183', 'recap');

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000181","role":"authenticated"}', true);
end $$;

select is(
  send_message('00000000-0000-0000-0000-000000001810', '  Salaam  ')->>'body',
  'Salaam',
  'the server trims message text'
);
select is(
  send_message('00000000-0000-0000-0000-000000001810', 'Second')->>'sender_id',
  '00000000-0000-0000-0000-000000000181',
  'the server owns sender identity'
);
select ok(
  (send_message('00000000-0000-0000-0000-000000001810', 'Unread')->>'read_at') is null,
  'the server owns the initial read state'
);
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000001810', '   ') $$,
  '22023', 'Message cannot be empty',
  'blank messages are rejected'
);
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000001810', repeat('x', 2001)) $$,
  '22001', 'Message is too long',
  'oversized messages are rejected'
);
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000001811', 'Too early') $$,
  '42501', 'Connection is not available',
  'messages cannot be sent before the connection is open'
);
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000009999', 'Not mine') $$,
  '42501', 'Connection is not available',
  'messages cannot be sent to a missing or unrelated connection'
);

-- Existing rows count toward a sender-wide rolling limit. RPC-created rows
-- above bring the total to 3; seed another 17 to reach the limit of 20.
insert into messages (connection_id, sender_id, body, created_at)
select '00000000-0000-0000-0000-000000001810',
       '00000000-0000-0000-0000-000000000181',
       'seed ' || n, now()
from generate_series(1, 17) n;
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000001810', 'One too many') $$,
  'P0001', 'Please wait before sending more messages',
  'the rolling per-minute limit is enforced'
);

-- Move rate-limit fixtures out of the active window before safety checks.
update messages set created_at = now() - interval '2 minutes'
where sender_id = '00000000-0000-0000-0000-000000000181';

insert into blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-000000000182', '00000000-0000-0000-0000-000000000181');
select ok(
  (select closed_at is not null and stage = 'closed'
   from connections where id = '00000000-0000-0000-0000-000000001810'),
  'a block immediately closes an existing connection'
);
select throws_ok(
  $$ select send_message('00000000-0000-0000-0000-000000001810', 'Blocked') $$,
  '42501', 'Connection is not available',
  'a blocked connection cannot send messages'
);
select throws_ok(
  $$ select mark_connection_messages_read('00000000-0000-0000-0000-000000001810') $$,
  '42501', 'Connection is not available',
  'a blocked connection cannot change read receipts'
);
select ok(
  not halal_mode_private.can_read_profile_media('00000000-0000-0000-0000-000000000182'),
  'a block immediately denies new private-media reads'
);

delete from blocks
where blocker_id = '00000000-0000-0000-0000-000000000182'
  and blocked_id = '00000000-0000-0000-0000-000000000181';
select throws_ok(
  $$ select get_connection('00000000-0000-0000-0000-000000001810') $$,
  'P0002', 'Connection not found',
  'removing a block does not reopen the closed connection or its message summary'
);
select ok(
  not halal_mode_private.can_read_profile_media('00000000-0000-0000-0000-000000000182'),
  'closing a connection denies new private-media reads even after unblock'
);
select ok(
  (select closed_at is not null from connections
   where id = '00000000-0000-0000-0000-000000001810'),
  'the closed connection remains terminal'
);
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'messages' and cmd = 'INSERT'),
  0,
  'no direct message INSERT policy remains'
);

select * from finish();
rollback;
