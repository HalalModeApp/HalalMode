begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('authenticated', 'public.get_connection_messages(uuid,timestamptz,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_connection_messages(uuid,timestamptz,uuid,integer)', 'EXECUTE'),
  'only authenticated members can request paginated history'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000271', 'history-a@example.test'),
  ('00000000-0000-0000-0000-000000000272', 'history-b@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000271', 'History A', 'History', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000272', 'History B', 'History', '1990-01-01', 'male', true);
insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000000273', '00000000-0000-0000-0000-000000000271', '00000000-0000-0000-0000-000000000272', 'open');
insert into messages (id, connection_id, sender_id, body, created_at) values
  ('00000000-0000-0000-0000-000000000274', '00000000-0000-0000-0000-000000000273', '00000000-0000-0000-0000-000000000271', 'one', '2026-01-01T01:00:00Z'),
  ('00000000-0000-0000-0000-000000000275', '00000000-0000-0000-0000-000000000273', '00000000-0000-0000-0000-000000000271', 'two', '2026-01-01T02:00:00Z'),
  ('00000000-0000-0000-0000-000000000276', '00000000-0000-0000-0000-000000000273', '00000000-0000-0000-0000-000000000272', 'three', '2026-01-01T03:00:00Z');

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000271","role":"authenticated"}', true);
end $$;

select is(
  jsonb_array_length(get_connection_messages('00000000-0000-0000-0000-000000000273', null, null, 2)->'messages'), 2,
  'the requested page size bounds returned history'
);
select is(
  get_connection_messages('00000000-0000-0000-0000-000000000273', null, null, 2)->'messages'->0->>'body', 'two',
  'a newest page is returned in chronological display order'
);
select ok(
  (get_connection_messages('00000000-0000-0000-0000-000000000273', null, null, 2)->>'hasMore')::boolean,
  'a full page advertises an earlier-history cursor'
);
select throws_ok(
  $$ select get_connection_messages('00000000-0000-0000-0000-000000000273', now(), null, 50) $$,
  '22023', 'Cursor is incomplete', 'partial cursors are rejected'
);

select * from finish();
rollback;
