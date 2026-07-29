begin;

set local search_path = public, extensions;
select plan(4);

select ok(
  has_function_privilege('authenticated', 'public.send_message(uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.send_message(uuid,text,text)', 'EXECUTE'),
  'idempotent sending remains authenticated-only'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000281', 'outbox-a@example.test'),
  ('00000000-0000-0000-0000-000000000282', 'outbox-b@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000281', 'Outbox A', 'Outbox', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000282', 'Outbox B', 'Outbox', '1990-01-01', 'male', true);
insert into halal_mode_private.member_legal_consent_history
  (user_id, document_type, version, acceptance_context)
select p.id, d.document_type, d.version, 'reacceptance'
from profiles p
cross join halal_mode_private.legal_document_registry d
where p.id in (
  '00000000-0000-0000-0000-000000000281',
  '00000000-0000-0000-0000-000000000282'
) and d.is_current;
insert into connections (id, user_a, user_b, stage) values
  ('00000000-0000-0000-0000-000000000283', '00000000-0000-0000-0000-000000000281', '00000000-0000-0000-0000-000000000282', 'open');
do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000281","role":"authenticated"}', true);
end $$;

select lives_ok(
  $$ select send_message('00000000-0000-0000-0000-000000000283', 'retry safely', 'mobile_request_0001') $$,
  'the first outbox delivery succeeds'
);
select is(
  (select count(*)::int from messages where connection_id = '00000000-0000-0000-0000-000000000283'), 1,
  'the first delivery creates one message'
);
select is(
  (select (send_message('00000000-0000-0000-0000-000000000283', 'retry safely', 'mobile_request_0001')->>'id')),
  (select id::text from messages where connection_id = '00000000-0000-0000-0000-000000000283'),
  'a retry returns the original message rather than creating a duplicate'
);

select * from finish();
rollback;
