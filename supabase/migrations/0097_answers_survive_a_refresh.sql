-- Let an exchanged answer survive a refresh.
--
-- The double blind works: submit_answer hands back the other answer only once
-- you have written your own. But that release lived exclusively in the response
-- to that one call. get_connection has only ever returned `myAnswer` — true
-- since 0005 and carried through 0015 and 0022 unchanged — so the moment the
-- screen was closed or refetched, the other answer was gone.
--
-- Two consequences, both found by walking the flow as two real members:
--
--   Whoever answered second saw the exchange once and lost it on the next read.
--   Whoever answered first never saw it at all, because nothing they could call
--   would return it, until every question was answered and the recap unlocked.
--
-- The client always expected better: `theirAnswer` is on the ConnectionQuestion
-- type and answers.tsx renders it. It was simply never sent.
--
-- The release condition here is exactly the one submit_answer applies — both
-- must have answered — so this widens no promise. It only makes the same
-- disclosure durable, and stops it depending on who happened to answer last.

create or replace function halal_mode_private.get_connection_after_legal_consent(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  c connections%rowtype;
  other_profile profiles%rowtype;
  questions jsonb;
begin
  select * into c
  from connections
  where id = p_id
    and closed_at is null
    and (user_a = auth.uid() or user_b = auth.uid());
  if c is null then raise exception 'Connection not found' using errcode = 'P0002'; end if;

  select * into other_profile
  from profiles
  where id = case when c.user_a = auth.uid() then c.user_b else c.user_a end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'questionId', picked.question_id,
        'origin', case
          when picked.picked_by_me and picked.picked_by_them then 'both'
          when picked.picked_by_me then 'me'
          else 'them'
        end,
        'myAnswer', coalesce(own_answer.body, ''),
        'mySubmittedAt', own_answer.submitted_at,
        -- Released only where this member has answered too, which is the same
        -- condition submit_answer already applies. Without it the reveal lived
        -- only in that one response and vanished on the next read.
        'theirAnswer', case
          when own_answer.body is not null and their_answer.body is not null
            then their_answer.body
        end,
        'theirSubmittedAt', case
          when own_answer.body is not null and their_answer.body is not null
            then their_answer.submitted_at
        end
      ) order by picked.question_id
    ),
    '[]'::jsonb
  ) into questions
  from (
    select qp.question_id,
           bool_or(qp.user_id = auth.uid()) as picked_by_me,
           bool_or(qp.user_id <> auth.uid()) as picked_by_them
    from question_picks qp
    where qp.connection_id = c.id
    group by qp.question_id
  ) picked
  left join question_answers own_answer
    on own_answer.connection_id = c.id
   and own_answer.question_id = picked.question_id
   and own_answer.user_id = auth.uid()
  left join question_answers their_answer
    on their_answer.connection_id = c.id
   and their_answer.question_id = picked.question_id
   and their_answer.user_id <> auth.uid();

  return jsonb_build_object(
    'id', c.id,
    'createdAt', c.created_at,
    'stage', c.stage,
    'profile', safe_member_profile(other_profile),
    'myQuestionPicksSubmitted', (
      select count(*) = 5 from question_picks qp
      where qp.connection_id = c.id and qp.user_id = auth.uid()
    ),
    'theirQuestionPicksSubmitted', (
      select count(*) = 5 from question_picks qp
      where qp.connection_id = c.id and qp.user_id <> auth.uid()
    ),
    'questions', questions,
    'recap', c.recap,
    'compatibilityBreakdown', build_connection_compatibility_breakdown(c.id),
    'lastMessage', (
      select coalesce(m.body, 'Voice note') from messages m
      where m.connection_id = c.id order by m.created_at desc limit 1
    ),
    'lastMessageAt', (
      select m.created_at from messages m
      where m.connection_id = c.id order by m.created_at desc limit 1
    ),
    'unread', exists (
      select 1 from messages m
      where m.connection_id = c.id
        and m.sender_id <> auth.uid()
        and m.read_at is null
    )
  );
end;
$$;

do $$
declare
  v_a uuid := '00000000-0000-4000-8000-0000000da001';
  v_b uuid := '00000000-0000-4000-8000-0000000da002';
  v_conn uuid;
  v_seen jsonb;
  v_q constant text := 'q1';
begin
  insert into auth.users (id, email) values
    (v_a, 'answer-a@halalmodetest.com'), (v_b, 'answer-b@halalmodetest.com');
  insert into public.profiles (id, name, first_name, birth_date, gender, onboarding_complete)
  values (v_a, 'Ans A', 'A', '1995-01-01', 'female', true),
         (v_b, 'Ans B', 'B', '1994-01-01', 'male', true);
  insert into halal_mode_private.member_legal_consent_history
    (user_id, document_type, version, acceptance_context)
  select u.id, d.document_type, d.version, 'migrated'
  from (values (v_a), (v_b)) u(id)
  cross join halal_mode_private.legal_document_registry d where d.is_current;

  insert into public.connections (user_a, user_b, stage)
  values (least(v_a, v_b), greatest(v_a, v_b), 'answering')
  returning id into v_conn;
  insert into public.question_picks (connection_id, user_id, question_id)
  values (v_conn, v_a, v_q), (v_conn, v_b, v_q);

  -- A answers first and must still see nothing.
  insert into public.question_answers (connection_id, user_id, question_id, body)
  values (v_conn, v_a, v_q, 'A answered first');

  perform set_config('request.jwt.claims', json_build_object('sub', v_a)::text, true);
  v_seen := halal_mode_private.get_connection_after_legal_consent(v_conn);
  assert (v_seen -> 'questions' -> 0 ->> 'theirAnswer') is null,
    'an unanswered question must not leak the other side';

  -- B answers, and now both may read both.
  insert into public.question_answers (connection_id, user_id, question_id, body)
  values (v_conn, v_b, v_q, 'B answered second');

  v_seen := halal_mode_private.get_connection_after_legal_consent(v_conn);
  assert (v_seen -> 'questions' -> 0 ->> 'theirAnswer') = 'B answered second',
    format('the first answerer should now see it; got %s',
           coalesce(v_seen -> 'questions' -> 0 ->> 'theirAnswer', 'null'));

  perform set_config('request.jwt.claims', json_build_object('sub', v_b)::text, true);
  v_seen := halal_mode_private.get_connection_after_legal_consent(v_conn);
  assert (v_seen -> 'questions' -> 0 ->> 'theirAnswer') = 'A answered first',
    'and the second answerer keeps it across a refetch';

  perform set_config('request.jwt.claims', '', true);
  set local role postgres;
  alter table halal_mode_private.member_legal_consent_history
    disable trigger member_legal_consent_history_append_only;
  delete from auth.users where id in (v_a, v_b);
  alter table halal_mode_private.member_legal_consent_history
    enable trigger member_legal_consent_history_append_only;

  assert not exists (select 1 from public.profiles where id in (v_a, v_b)),
    'the fixture must not outlive the check';
end;
$$;
