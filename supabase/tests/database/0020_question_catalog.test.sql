begin;

set local search_path = public, extensions;
select plan(29);

select is((select count(*)::int from question_catalog), 12, 'the server catalog contains all twelve client questions');
select is(
  (select array_agg(id order by display_order) from question_catalog),
  array['q1','q2','q3','q4','q5','q6','q7','q8','q9','q10','q11','q12']::text[],
  'server question IDs exactly match the ordered client library'
);
select ok((select bool_and(catalog_version = 1 and active) from question_catalog), 'the initial catalog is versioned and active');
select ok(
  not has_table_privilege('authenticated', 'public.question_catalog', 'SELECT')
    and not has_table_privilege('authenticated', 'public.question_catalog', 'INSERT'),
  'clients cannot inspect or mutate the authoritative catalog'
);
select ok(
  not has_table_privilege('authenticated', 'public.connection_questions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.connection_questions', 'INSERT'),
  'clients cannot inspect or forge agreed question snapshots'
);
select ok(
  position('question_catalog' in pg_get_functiondef('public.submit_question_picks(uuid,text[])'::regprocedure)) > 0,
  'question submission validates against the catalog'
);
select ok(
  position('connection_questions' in pg_get_functiondef('public.submit_answer(uuid,text,text)'::regprocedure)) > 0,
  'answer submission validates against the connection snapshot'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000201', 'questions-a@example.test'),
  ('00000000-0000-0000-0000-000000000202', 'questions-b@example.test'),
  ('00000000-0000-0000-0000-000000000203', 'questions-c@example.test'),
  ('00000000-0000-0000-0000-000000000204', 'questions-d@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000201', 'Question A', 'A', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000000202', 'Question B', 'B', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000203', 'Question C', 'C', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000000204', 'Question D', 'D', '1990-01-01', 'female', true);
insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000002001', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000202', 'choosing_questions'),
  ('00000000-0000-0000-0000-000000002002', '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000204', 'choosing_questions');

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated"}', true);
end $$;

select throws_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q1','q2','q3','q4','forged']) $$,
  '22023', 'One or more questions are unavailable',
  'an unknown question ID is rejected'
);
select is(
  (select count(*)::int from question_picks where connection_id = '00000000-0000-0000-0000-000000002001'),
  0,
  'unknown-ID rejection leaves no partial picks'
);
select throws_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q1','q1','q2','q3','q4']) $$,
  '22023', 'Choose exactly five different questions',
  'duplicate question IDs are rejected explicitly'
);
select throws_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q1','q2','q3','q4',null]) $$,
  '22023', 'Choose exactly five different questions',
  'null question IDs are rejected explicitly'
);
select lives_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q1','q2','q3','q4','q5']) $$,
  'five distinct active catalog IDs are accepted'
);
select is(
  (select count(*)::int from question_picks where connection_id = '00000000-0000-0000-0000-000000002001' and user_id = '00000000-0000-0000-0000-000000000201'),
  5,
  'valid submission writes exactly five picks'
);
select lives_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q5','q4','q3','q2','q1']) $$,
  'an exact reordered retry is idempotent'
);
select throws_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q1','q2','q3','q4','q6']) $$,
  '22023', 'Question choices were already submitted',
  'a submitted choice set cannot be rewritten'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000202","role":"authenticated"}', true);
end $$;
select lives_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002001', array['q4','q5','q6','q7','q8']) $$,
  'the other member can submit a valid set'
);
select is(
  (select stage::text from connections where id = '00000000-0000-0000-0000-000000002001'),
  'answering',
  'both valid submissions advance the connection'
);
select is(
  (select count(*)::int from connection_questions where connection_id = '00000000-0000-0000-0000-000000002001'),
  8,
  'the immutable agreed set contains the distinct union of both choices'
);
select ok(
  (select picked_by_a and picked_by_b from connection_questions
   where connection_id = '00000000-0000-0000-0000-000000002001' and question_id = 'q4'),
  'the snapshot preserves questions chosen by both members'
);
select throws_ok(
  $$ select submit_answer('00000000-0000-0000-0000-000000002001', 'q12', 'This catalog question was never agreed here.') $$,
  '22023', 'Question is not in this connection',
  'even a real catalog ID is rejected when absent from this connection'
);
select is(
  submit_answer('00000000-0000-0000-0000-000000002001', 'q1', 'The first private answer from member B.')->>'theirAnswer',
  null,
  'the first answer cannot see the other member answer'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000201","role":"authenticated"}', true);
end $$;
select is(
  submit_answer('00000000-0000-0000-0000-000000002001', 'q1', 'The private answer from member A now committed.')->>'theirAnswer',
  'The first private answer from member B.',
  'the other answer is revealed only after the caller commits'
);
select is(
  submit_answer('00000000-0000-0000-0000-000000002001', 'q1', 'A replacement that must never overwrite the first.')->>'myAnswer',
  'The private answer from member A now committed.',
  'answer replay remains write-once'
);

update question_catalog set active = false where id in ('q2', 'q9');
select is(
  submit_answer('00000000-0000-0000-0000-000000002001', 'q2', 'This agreed question remains valid after catalog retirement.')->>'questionId',
  'q2',
  'catalog retirement does not invalidate an agreed snapshot'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000203","role":"authenticated"}', true);
end $$;
select throws_ok(
  $$ select submit_question_picks('00000000-0000-0000-0000-000000002002', array['q6','q7','q8','q9','q10']) $$,
  '22023', 'One or more questions are unavailable',
  'retired questions cannot be selected for a new connection'
);
select is(
  (select count(*)::int from connection_questions where connection_id = '00000000-0000-0000-0000-000000002002'),
  0,
  'failed new selection cannot manufacture an agreed set'
);
select ok(
  not has_function_privilege('anon', 'public.submit_question_picks(uuid,text[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.submit_answer(uuid,text,text)', 'EXECUTE'),
  'anonymous callers cannot reach question or answer RPCs'
);
select ok(
  not has_function_privilege('authenticated', 'public.refresh_connection_stage_after_answer(uuid)', 'EXECUTE'),
  'the stage transition helper remains internal-only'
);
select is(
  (select count(*)::int from question_answers
   where connection_id = '00000000-0000-0000-0000-000000002001' and question_id = 'q1'),
  2,
  'double-blind answers contain exactly one immutable row per member'
);

select * from finish();
rollback;
