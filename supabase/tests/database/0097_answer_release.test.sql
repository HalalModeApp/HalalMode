begin;

set local search_path = public, extensions;
select plan(7);

-- The double blind, and the thing that was missing beside it.
--
-- submit_answer released the other answer only in its own response, so the
-- reveal vanished on the next read and the member who answered first never saw
-- it at all. 0097 made it durable without widening what is released: both must
-- still have answered.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000008001', 'answer-one@example.test'),
  ('00000000-0000-0000-0000-000000008002', 'answer-two@example.test'),
  ('00000000-0000-0000-0000-000000008003', 'answer-outsider@example.test');

insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete)
values
  ('00000000-0000-0000-0000-000000008001', 'Answer One', 'One', '1995-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000008002', 'Answer Two', 'Two', '1994-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000008003', 'Outsider', 'Out', '1993-01-01', 'male', true);

insert into halal_mode_private.member_legal_consent_history
  (user_id, document_type, version, acceptance_context)
select u.id, d.document_type, d.version, 'reacceptance'
from (values
  ('00000000-0000-0000-0000-000000008001'::uuid),
  ('00000000-0000-0000-0000-000000008002'::uuid),
  ('00000000-0000-0000-0000-000000008003'::uuid)
) u(id)
cross join halal_mode_private.legal_document_registry d
where d.is_current;

insert into connections (id, user_a, user_b, stage) values (
  '00000000-0000-0000-0000-00000000800c',
  least('00000000-0000-0000-0000-000000008001'::uuid, '00000000-0000-0000-0000-000000008002'::uuid),
  greatest('00000000-0000-0000-0000-000000008001'::uuid, '00000000-0000-0000-0000-000000008002'::uuid),
  'answering'
);

-- Two questions: one both will answer, one only the first member touches.
insert into question_picks (connection_id, user_id, question_id) values
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008001', 'q1'),
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008002', 'q1'),
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008001', 'q2'),
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008002', 'q2');

insert into question_answers (connection_id, user_id, question_id, body) values
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008001', 'q1', 'one on q1'),
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008001', 'q2', 'one on q2');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000008001","role":"authenticated"}', true);

-- Nobody has answered back yet, so nothing may be visible.
select is(
  (select q ->> 'theirAnswer'
   from jsonb_array_elements(
     halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') -> 'questions') q
   where q ->> 'questionId' = 'q1'),
  null,
  'answering first reveals nothing'
);

insert into question_answers (connection_id, user_id, question_id, body) values
  ('00000000-0000-0000-0000-00000000800c', '00000000-0000-0000-0000-000000008002', 'q1', 'two on q1');

select is(
  (select q ->> 'theirAnswer'
   from jsonb_array_elements(
     halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') -> 'questions') q
   where q ->> 'questionId' = 'q1'),
  'two on q1',
  'once both have answered, the first member sees it too — and keeps seeing it'
);

-- The question the other member has not answered stays shut, in the same read.
select is(
  (select q ->> 'theirAnswer'
   from jsonb_array_elements(
     halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') -> 'questions') q
   where q ->> 'questionId' = 'q2'),
  null,
  'a released answer on one question does not release another'
);

-- And from the other side, which is where the reveal used to live transiently.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000008002","role":"authenticated"}', true);

select is(
  (select q ->> 'theirAnswer'
   from jsonb_array_elements(
     halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') -> 'questions') q
   where q ->> 'questionId' = 'q1'),
  'one on q1',
  'the second answerer keeps the reveal across a refetch'
);

select is(
  (select q ->> 'theirAnswer'
   from jsonb_array_elements(
     halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') -> 'questions') q
   where q ->> 'questionId' = 'q2'),
  null,
  'and still cannot read an answer they have not matched'
);

-- Nobody outside the connection, whatever they ask for.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000008003","role":"authenticated"}', true);

-- Raises rather than returning an empty payload, which is the stronger answer:
-- there is no shape for a caller to inspect and no null to mistake for "no
-- answers yet".
select throws_ok(
  $$ select halal_mode_private.get_connection_after_legal_consent(
       '00000000-0000-0000-0000-00000000800c') $$,
  null,
  null,
  'a member outside the connection is refused outright'
);

select ok(
  not has_table_privilege('authenticated', 'public.question_answers', 'SELECT'),
  'answers are never readable straight off the table'
);

select * from finish();
rollback;
