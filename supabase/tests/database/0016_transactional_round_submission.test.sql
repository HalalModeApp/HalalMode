begin;

set local search_path = public, extensions;
select plan(17);

select ok(
  has_function_privilege('authenticated', 'public.submit_round_selections(uuid,uuid[])', 'EXECUTE'),
  'authenticated members may submit a round'
);
select ok(
  not has_function_privilege('anon', 'public.submit_round_selections(uuid,uuid[])', 'EXECUTE'),
  'anonymous callers cannot submit a round'
);
select ok(
  position('for update' in lower(pg_get_functiondef('public.submit_round_selections(uuid,uuid[])'::regprocedure))) > 0,
  'round submission locks its round row'
);
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.submit_round_selections(uuid,uuid[])'::regprocedure)) > 0,
  'reciprocal pair checks are serialized under concurrent submissions'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'round-a@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'round-b@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'round-c@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'round-d@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, onboarding_complete
) values
  ('00000000-0000-0000-0000-0000000000a1', 'Member A', 'A', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-0000000000b2', 'Member B', 'B', '1991-01-01', 'female', true),
  ('00000000-0000-0000-0000-0000000000c3', 'Member C', 'C', '1992-01-01', 'female', true),
  ('00000000-0000-0000-0000-0000000000d4', 'Member D', 'D', '1993-01-01', 'male', true);

insert into selection_scores (user_id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000d4');

insert into rounds (id, user_id, tier, expires_at) values
  ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-0000000000a1', 'free', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-0000000000b2', 'free', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-000000001003', '00000000-0000-0000-0000-0000000000c3', 'free', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-000000001004', '00000000-0000-0000-0000-0000000000d4', 'free', now() - interval '1 minute');

insert into introductions (id, round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-000000002001', '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-000000002002', '00000000-0000-0000-0000-000000001002', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000002003', '00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-000000002004', '00000000-0000-0000-0000-000000001003', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d4'),
  ('00000000-0000-0000-0000-000000002005', '00000000-0000-0000-0000-000000001004', '00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000c3');

update introductions set reciprocal_id = '00000000-0000-0000-0000-000000002002'
where id = '00000000-0000-0000-0000-000000002001';
update introductions set reciprocal_id = '00000000-0000-0000-0000-000000002001'
where id = '00000000-0000-0000-0000-000000002002';

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
end $$;

select throws_ok(
  $$ select submit_round_selections('00000000-0000-0000-0000-000000001002', '{}'::uuid[]) $$,
  'P0002', 'Round not found',
  'a member cannot submit another member round'
);
select throws_ok(
  $$ select submit_round_selections('00000000-0000-0000-0000-000000001001', array['00000000-0000-0000-0000-000000002004']::uuid[]) $$,
  '22023', 'Every introduction must belong to this round',
  'a foreign introduction is rejected'
);
select throws_ok(
  $$ select submit_round_selections('00000000-0000-0000-0000-000000001001', array['00000000-0000-0000-0000-000000002001','00000000-0000-0000-0000-000000002003']::uuid[]) $$,
  '22023', 'At most 1 selections allowed on this tier',
  'tier keep limit is enforced before writes'
);
select is(
  (select count(*)::int from introduction_selections where viewer_id = '00000000-0000-0000-0000-0000000000a1'),
  0,
  'failed submissions leave no partial selection effects'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}', true);
end $$;
select throws_ok(
  $$ select submit_round_selections('00000000-0000-0000-0000-000000001004', '{}'::uuid[]) $$,
  '22023', 'Round has expired',
  'expired rounds are rejected'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
end $$;
select is(
  submit_round_selections(
    '00000000-0000-0000-0000-000000001002',
    array['00000000-0000-0000-0000-000000002002']::uuid[]
  )->'mutualProfileIds',
  '[]'::jsonb,
  'the first one-sided keep does not activate a mutual'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
end $$;
select is(
  submit_round_selections(
    '00000000-0000-0000-0000-000000001001',
    array['00000000-0000-0000-0000-000000002001']::uuid[]
  )->'mutualProfileIds',
  '["00000000-0000-0000-0000-0000000000b2"]'::jsonb,
  'linked reciprocal keeps activate one mutual'
);
select is(
  (select row(times_shown, times_kept)::text from selection_scores where user_id = '00000000-0000-0000-0000-0000000000b2'),
  '(1,1)',
  'the kept subject is scored once for the exact round'
);
select is(
  (select row(times_shown, times_kept)::text from selection_scores where user_id = '00000000-0000-0000-0000-0000000000c3'),
  '(1,0)',
  'the released subject is scored once for the exact round'
);
select is(
  (select count(*)::int from connections where user_a = '00000000-0000-0000-0000-0000000000a1' and user_b = '00000000-0000-0000-0000-0000000000b2'),
  1,
  'mutual submission creates exactly one connection'
);
select ok(
  (select submitted_at is not null from rounds where id = '00000000-0000-0000-0000-000000001001'),
  'the valid round is marked submitted'
);
select throws_ok(
  $$ select submit_round_selections('00000000-0000-0000-0000-000000001001', array['00000000-0000-0000-0000-000000002001']::uuid[]) $$,
  '22023', 'Round already submitted',
  'a sequential retry is rejected'
);
select is(
  (select times_shown from selection_scores where user_id = '00000000-0000-0000-0000-0000000000b2'),
  1,
  'a retry cannot score the round twice'
);

select * from finish();
rollback;
