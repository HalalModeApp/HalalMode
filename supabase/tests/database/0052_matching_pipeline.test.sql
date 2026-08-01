begin;
set local search_path = public, extensions;
select plan(18);

select ok(
  not has_table_privilege('anon', 'halal_mode_private.matching_pool', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_pool', 'SELECT'),
  'the eligible pool remains private'
);
select ok(
  not has_function_privilege('authenticated', 'public.matching_candidate_edges_service(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.persist_matching_round_service(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'members cannot fetch candidate scores or persist a plan'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005201', 'pipeline-a@example.test'),
  ('00000000-0000-0000-0000-000000005202', 'pipeline-b@example.test'),
  ('00000000-0000-0000-0000-000000005203', 'at-cap@example.test'),
  ('00000000-0000-0000-0000-000000005211', 'cap-1@example.test'),
  ('00000000-0000-0000-0000-000000005212', 'cap-2@example.test'),
  ('00000000-0000-0000-0000-000000005213', 'cap-3@example.test'),
  ('00000000-0000-0000-0000-000000005214', 'cap-4@example.test'),
  ('00000000-0000-0000-0000-000000005215', 'cap-5@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005201', 'Pipeline A', 'A', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['a.jpg'], true),
  ('00000000-0000-0000-0000-000000005202', 'Pipeline B', 'B', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('b', 50), array['b.jpg'], true),
  ('00000000-0000-0000-0000-000000005203', 'At Capacity', 'Cap', '1989-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('c', 50), array['c.jpg'], true),
  ('00000000-0000-0000-0000-000000005211', 'Cap One', 'One', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005212', 'Cap Two', 'Two', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005213', 'Cap Three', 'Three', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005214', 'Cap Four', 'Four', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005215', 'Cap Five', 'Five', '1990-01-01', 'female', '', '', null, null, '', '{}', false);

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000005201', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005202', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005203', 18, 50, array['Saudi Arabia'], 100, now());

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (values
  ('00000000-0000-0000-0000-000000005201'::uuid),
  ('00000000-0000-0000-0000-000000005202'::uuid),
  ('00000000-0000-0000-0000-000000005203'::uuid)
) member(id)
cross join halal_mode_private.legal_document_registry document
where document.is_current;

insert into connections (user_a, user_b) values
  ('00000000-0000-0000-0000-000000005203', '00000000-0000-0000-0000-000000005211'),
  ('00000000-0000-0000-0000-000000005203', '00000000-0000-0000-0000-000000005212'),
  ('00000000-0000-0000-0000-000000005203', '00000000-0000-0000-0000-000000005213'),
  ('00000000-0000-0000-0000-000000005203', '00000000-0000-0000-0000-000000005214'),
  ('00000000-0000-0000-0000-000000005203', '00000000-0000-0000-0000-000000005215');

select ok(
  not exists (
    select 1 from halal_mode_private.matching_pool
    where id = '00000000-0000-0000-0000-000000005203'
  ),
  'a member at the active connection cap is excluded from the pool'
);
select ok(
  (select count(*)
   from halal_mode_private.matching_pool
   where id in ('00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202')) = 2,
  'ready consenting members below capacity enter the pool'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  exists (
    select 1 from public.matching_candidate_edges_service(null, null, 1000)
    where user_low = '00000000-0000-0000-0000-000000005201'
      and user_high = '00000000-0000-0000-0000-000000005202'
  ),
  'a mutually eligible pair is returned'
);

insert into halal_mode_private.pair_exposure (
  user_low, user_high, times_shown, cooldown_until
) values (
  '00000000-0000-0000-0000-000000005201',
  '00000000-0000-0000-0000-000000005202', 1, now() + interval '1 day'
);
select ok(
  not exists (
    select 1 from public.matching_candidate_edges_service(null, null, 1000)
    where user_low = '00000000-0000-0000-0000-000000005201'
      and user_high = '00000000-0000-0000-0000-000000005202'
  ),
  'a pair still in cooldown is excluded'
);
update halal_mode_private.pair_exposure
set cooldown_until = null, retired_at = now(), retired_reason = 'test'
where user_low = '00000000-0000-0000-0000-000000005201'
  and user_high = '00000000-0000-0000-0000-000000005202';
select ok(
  not exists (
    select 1 from public.matching_candidate_edges_service(null, null, 1000)
    where user_low = '00000000-0000-0000-0000-000000005201'
      and user_high = '00000000-0000-0000-0000-000000005202'
  ),
  'a retired pair is excluded'
);
delete from halal_mode_private.pair_exposure
where user_low = '00000000-0000-0000-0000-000000005201'
  and user_high = '00000000-0000-0000-0000-000000005202';

insert into rounds (id, user_id, tier, expires_at, submitted_at)
values ('00000000-0000-0000-0000-000000005221', '00000000-0000-0000-0000-000000005201', 'free', now() + interval '1 day', now());
insert into introductions (id, round_id, viewer_id, subject_id)
values ('00000000-0000-0000-0000-000000005222', '00000000-0000-0000-0000-000000005221', '00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202');
insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
values ('00000000-0000-0000-0000-000000005222', '00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202', 'explicit_pass');
select ok(
  not exists (
    select 1 from public.matching_candidate_edges_service(null, null, 1000)
    where user_low = '00000000-0000-0000-0000-000000005201'
      and user_high = '00000000-0000-0000-0000-000000005202'
  ),
  'a deliberate explicit pass permanently excludes the pair'
);
delete from introduction_selections where introduction_id = '00000000-0000-0000-0000-000000005222';
delete from introductions where id = '00000000-0000-0000-0000-000000005222';
delete from rounds where id = '00000000-0000-0000-0000-000000005221';

select ok(
  not exists (
    select 1
    from (
      select user_low, user_high,
             lag(user_low) over (order by user_low, user_high) as previous_low,
             lag(user_high) over (order by user_low, user_high) as previous_high
      from public.matching_candidate_edges_service(null, null, 1000)
    ) ordered
    where (user_low, user_high) < (previous_low, previous_high)
  ),
  'candidate pages have deterministic key order'
);

create temporary table pipeline_run (id uuid primary key) on commit drop;
insert into pipeline_run values (public.matching_run_start(
  'test-v1', halal_mode_private.active_matching_config_version(), 5200, 'live'
));

select throws_ok(
  format(
    $$select public.persist_matching_round_service(
      %L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005201","b":"00000000-0000-0000-0000-000000005202","score":0.70,"utility":0.74},{"a":"00000000-0000-0000-0000-000000005201","b":"00000000-0000-0000-0000-000000005201","score":0.80,"utility":0.82}]'::jsonb,
      '[{"user_id":"00000000-0000-0000-0000-000000005201","outcome":"served"},{"user_id":"00000000-0000-0000-0000-000000005202","outcome":"served"}]'::jsonb,
      now() + interval '1 day')$$,
    (select id from pipeline_run)
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'one invalid edge rejects the entire plan'
);
select is((select count(*)::integer from rounds where user_id in (
  '00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202'
)), 0, 'a rejected plan creates no rounds');
select is((select count(*)::integer from introductions where viewer_id in (
  '00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202'
)), 0, 'a rejected plan creates no introductions');

select is(
  public.persist_matching_round_service(
    (select id from pipeline_run),
    '[{"a":"00000000-0000-0000-0000-000000005201","b":"00000000-0000-0000-0000-000000005202","score":0.70,"utility":0.74}]'::jsonb,
    '[{"user_id":"00000000-0000-0000-0000-000000005201","outcome":"served"},{"user_id":"00000000-0000-0000-0000-000000005202","outcome":"served"}]'::jsonb,
    now() + interval '1 day'
  ),
  1,
  'a valid one-pair plan persists once'
);
select is((select count(*)::integer from introductions where viewer_id in (
  '00000000-0000-0000-0000-000000005201', '00000000-0000-0000-0000-000000005202'
)), 2, 'a valid pair creates exactly two cards');
select ok(
  exists (
    select 1 from introductions a
    join introductions b on b.id = a.reciprocal_id and b.reciprocal_id = a.id
    where a.viewer_id = '00000000-0000-0000-0000-000000005201'
      and a.subject_id = '00000000-0000-0000-0000-000000005202'
  ),
  'both cards are atomically linked reciprocal twins'
);
select is((select count(*)::integer
  from halal_mode_private.matching_member_run_outcomes
  where run_id = (select id from pipeline_run)), 2, 'live outcomes are recorded for both members');
select is((select times_shown
  from halal_mode_private.pair_exposure
  where user_low = '00000000-0000-0000-0000-000000005201'
    and user_high = '00000000-0000-0000-0000-000000005202'), 1, 'pair exposure advances exactly once');
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.pair_exposure', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_member_run_outcomes', 'SELECT'),
  'members cannot inspect exposure history or matching outcomes'
);

select * from finish();
rollback;
