begin;

set local search_path = public, extensions;
select plan(28);

select is((select open_connections from tier_limits('free')), 5, 'free members have five conversation slots');
select is((select open_connections from tier_limits('plus')), 10, 'Plus members have ten conversation slots');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.mutual_connection_queue'::regclass),
  'the waiting-mutual queue has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.mutual_connection_queue', 'SELECT'),
  'clients cannot inspect the waiting-mutual queue'
);
select ok(
  not has_function_privilege(
    'authenticated', 'halal_mode_private.promote_waiting_connections(uuid[])', 'EXECUTE'
  ),
  'clients cannot invoke queue promotion'
);
select ok(
  position('pg_advisory_xact_lock' in
    pg_get_functiondef('public.submit_round_selections(uuid,uuid[])'::regprocedure)) > 0,
  'round submission uses transaction-scoped member locks'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000191', 'capacity-plus@example.test'),
  ('00000000-0000-0000-0000-000000000192', 'capacity-b@example.test'),
  ('00000000-0000-0000-0000-000000000193', 'capacity-c@example.test'),
  ('00000000-0000-0000-0000-000000000194', 'capacity-d@example.test');
insert into profiles (id, name, first_name, birth_date, gender, tier, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000191', 'Capacity Plus', 'Plus', '1990-01-01', 'male', 'plus', true),
  ('00000000-0000-0000-0000-000000000192', 'Capacity B', 'B', '1990-01-01', 'female', 'free', true),
  ('00000000-0000-0000-0000-000000000193', 'Capacity C', 'C', '1990-01-01', 'female', 'free', true),
  ('00000000-0000-0000-0000-000000000194', 'Capacity D', 'D', '1990-01-01', 'female', 'free', true);

create temporary table capacity_fillers (id uuid primary key) on commit drop;
insert into capacity_fillers select gen_random_uuid() from generate_series(1, 9);
insert into auth.users (id, email)
select id, 'capacity-' || row_number() over () || '@example.test' from capacity_fillers;
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete)
select id, 'Filler', 'Filler', '1990-01-01', 'female', true from capacity_fillers;
insert into connections (user_a, user_b)
select least('00000000-0000-0000-0000-000000000191'::uuid, id),
       greatest('00000000-0000-0000-0000-000000000191'::uuid, id)
from capacity_fillers;

insert into rounds (id, user_id, tier, expires_at, submitted_at) values
  ('00000000-0000-0000-0000-000000001901', '00000000-0000-0000-0000-000000000191', 'plus', now() + interval '1 hour', null),
  ('00000000-0000-0000-0000-000000001902', '00000000-0000-0000-0000-000000000192', 'free', now() + interval '1 hour', now()),
  ('00000000-0000-0000-0000-000000001903', '00000000-0000-0000-0000-000000000193', 'free', now() + interval '1 hour', now());
insert into introductions (id, round_id, viewer_id, subject_id, reciprocal_id) values
  ('00000000-0000-0000-0000-000000002911', '00000000-0000-0000-0000-000000001901', '00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000000192', '00000000-0000-0000-0000-000000002912'),
  ('00000000-0000-0000-0000-000000002912', '00000000-0000-0000-0000-000000001902', '00000000-0000-0000-0000-000000000192', '00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000002911'),
  ('00000000-0000-0000-0000-000000002913', '00000000-0000-0000-0000-000000001901', '00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000000193', '00000000-0000-0000-0000-000000002914'),
  ('00000000-0000-0000-0000-000000002914', '00000000-0000-0000-0000-000000001903', '00000000-0000-0000-0000-000000000193', '00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000002913');
insert into introduction_selections (introduction_id, viewer_id, subject_id, decision) values
  ('00000000-0000-0000-0000-000000002912', '00000000-0000-0000-0000-000000000192', '00000000-0000-0000-0000-000000000191', 'kept'),
  ('00000000-0000-0000-0000-000000002914', '00000000-0000-0000-0000-000000000193', '00000000-0000-0000-0000-000000000191', 'kept');

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000191","role":"authenticated"}', true);
end $$;

create temporary table capacity_result (payload jsonb) on commit drop;
insert into capacity_result values (submit_round_selections(
  '00000000-0000-0000-0000-000000001901',
  array['00000000-0000-0000-0000-000000002911','00000000-0000-0000-0000-000000002913']::uuid[]
));

select is(
  (select payload->'mutualProfileIds' from capacity_result),
  '["00000000-0000-0000-0000-000000000192"]'::jsonb,
  'only the first simultaneous mutual activates into the final Plus slot'
);
select is(
  (select payload->'waitingMutualProfileIds' from capacity_result),
  '["00000000-0000-0000-0000-000000000193"]'::jsonb,
  'the next simultaneous mutual is returned as waiting'
);
select is(
  (select count(*)::int from connections
   where closed_at is null and (user_a = '00000000-0000-0000-0000-000000000191' or user_b = '00000000-0000-0000-0000-000000000191')),
  10,
  'simultaneous mutuals cannot exceed the Plus capacity'
);
select is(
  (select count(*)::int from connections
   where closed_at is null and (user_a = '00000000-0000-0000-0000-000000000192' or user_b = '00000000-0000-0000-0000-000000000192')),
  1,
  'activation also accounts for the other member capacity'
);
select ok(
  exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000192'),
  'the mutual with available capacity becomes a connection'
);
select ok(
  not exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000193'),
  'the capacity-blocked mutual does not become an over-cap connection'
);
select ok(
  exists (select 1 from mutual_connection_queue where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000193'),
  'the capacity-blocked mutual is retained privately'
);

create temporary table closed_capacity_fixture (id uuid) on commit drop;
insert into closed_capacity_fixture
select c.id from connections c
join capacity_fillers f on f.id in (c.user_a, c.user_b)
where '00000000-0000-0000-0000-000000000191' in (c.user_a, c.user_b)
limit 1;
select lives_ok(
  format('select close_connection(%L::uuid)', (select id from closed_capacity_fixture)),
  'closing an active connection succeeds'
);
select ok(
  exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000193' and closed_at is null),
  'closing a connection automatically promotes the oldest waiting mutual'
);
select ok(
  not exists (select 1 from mutual_connection_queue where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000193'),
  'promotion consumes the waiting-mutual row'
);
select is(
  (select count(*)::int from connections
   where closed_at is null and (user_a = '00000000-0000-0000-0000-000000000191' or user_b = '00000000-0000-0000-0000-000000000191')),
  10,
  'closed connections do not consume capacity'
);
select ok(
  (select closed_at is not null from connections where id = (select id from closed_capacity_fixture)),
  'the explicitly closed row remains closed'
);

insert into mutual_connection_queue (user_a, user_b)
values ('00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000000194');
insert into blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-000000000191', '00000000-0000-0000-0000-000000000192');
select ok(
  (select closed_at is not null and stage = 'closed' from connections
   where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000192'),
  'blocking closes the active connection and frees its slot'
);
select ok(
  exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000194' and closed_at is null),
  'a slot freed by blocking promotes another waiting mutual'
);
select ok(
  not exists (select 1 from mutual_connection_queue where user_a = '00000000-0000-0000-0000-000000000191' and user_b = '00000000-0000-0000-0000-000000000194'),
  'block-triggered promotion consumes its queue row'
);
select is(
  (select count(*)::int from connections
   where closed_at is null and (user_a = '00000000-0000-0000-0000-000000000191' or user_b = '00000000-0000-0000-0000-000000000191')),
  10,
  'block-triggered promotion still respects the member cap'
);
select ok(
  (select payload ? 'mutualProfileIds' and payload ? 'waitingMutualProfileIds' from capacity_result),
  'the response keeps the existing field and adds an explicit waiting field'
);
select is(
  (select count(*)::int from mutual_connection_queue),
  0,
  'no stale waiting rows remain after promotion'
);

-- More than the old combined scan limit of stale rows for one member must not
-- hide either that member's real candidate or another supplied member's slot.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000205', 'fair-e@example.test'),
  ('00000000-0000-0000-0000-000000000206', 'fair-f@example.test'),
  ('00000000-0000-0000-0000-000000000207', 'fair-target-e@example.test'),
  ('00000000-0000-0000-0000-000000000208', 'fair-target-f@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete) values
  ('00000000-0000-0000-0000-000000000205', 'Fair E', 'E', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000000206', 'Fair F', 'F', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000000207', 'Fair Target E', 'TE', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000000208', 'Fair Target F', 'TF', '1990-01-01', 'female', true);

create temporary table stale_capacity_members (id uuid primary key) on commit drop;
insert into stale_capacity_members select gen_random_uuid() from generate_series(1, 21);
insert into auth.users (id, email)
select id, 'stale-' || row_number() over () || '@example.test' from stale_capacity_members;
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete)
select id, 'Stale', 'Stale', '1990-01-01', 'female', true from stale_capacity_members;
insert into connections (user_a, user_b, stage, closed_at)
select least('00000000-0000-0000-0000-000000000205'::uuid, id),
       greatest('00000000-0000-0000-0000-000000000205'::uuid, id),
       'closed', now() - interval '1 day'
from stale_capacity_members;
insert into mutual_connection_queue (user_a, user_b, matched_at)
select least('00000000-0000-0000-0000-000000000205'::uuid, id),
       greatest('00000000-0000-0000-0000-000000000205'::uuid, id),
       now() - interval '2 days'
from stale_capacity_members;
insert into mutual_connection_queue (user_a, user_b, matched_at) values
  ('00000000-0000-0000-0000-000000000205', '00000000-0000-0000-0000-000000000207', now() - interval '1 day'),
  ('00000000-0000-0000-0000-000000000206', '00000000-0000-0000-0000-000000000208', now() - interval '1 day');

select is(
  halal_mode_private.promote_waiting_connections(array[
    '00000000-0000-0000-0000-000000000205',
    '00000000-0000-0000-0000-000000000206'
  ]::uuid[]),
  2,
  'stale crowding cannot hide one eligible candidate per supplied member'
);
select ok(
  exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000205' and user_b = '00000000-0000-0000-0000-000000000207' and closed_at is null),
  'the crowded member receives its oldest eligible connection'
);
select ok(
  exists (select 1 from connections where user_a = '00000000-0000-0000-0000-000000000206' and user_b = '00000000-0000-0000-0000-000000000208' and closed_at is null),
  'another supplied member retains a fair share of the scan'
);
select is(
  (select count(*)::int from mutual_connection_queue q
   where exists (select 1 from connections c where c.user_a = q.user_a and c.user_b = q.user_b)),
  0,
  'bounded hygiene removes the stale existing-connection queue rows in the fixture'
);

select * from finish();
rollback;
