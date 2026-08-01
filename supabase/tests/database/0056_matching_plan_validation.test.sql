begin;
set local search_path = public, extensions;
select plan(29);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005601', 'validator-a@example.test'),
  ('00000000-0000-0000-0000-000000005602', 'validator-b@example.test'),
  ('00000000-0000-0000-0000-000000005603', 'validator-c@example.test'),
  ('00000000-0000-0000-0000-000000005604', 'validator-d@example.test');
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'validator-' || n || '@example.test'
from generate_series(5621, 5626) n;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005699', 'validator-unready@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005601', 'Validator A', 'A', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['a.jpg'], true),
  ('00000000-0000-0000-0000-000000005602', 'Validator B', 'B', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('b', 50), array['b.jpg'], true),
  ('00000000-0000-0000-0000-000000005603', 'Validator C', 'C', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4675, 39.6027, repeat('c', 50), array['c.jpg'], true),
  ('00000000-0000-0000-0000-000000005604', 'Validator D', 'D', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4682, 39.6032, repeat('d', 50), array['d.jpg'], true);
insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'Capacity ' || n, 'Capacity', '1991-01-01', 'female', 'Madinah',
       'Saudi Arabia', 24.4680 + ((n - 5620)::numeric / 10000), 39.6030,
       repeat('e', 50), array['e.jpg'], true
from generate_series(5621, 5626) n;
insert into profiles (
  id, name, first_name, birth_date, gender, onboarding_complete
) values (
  '00000000-0000-0000-0000-000000005699', 'Unready', 'Unready',
  '1991-01-01', 'female', false
);

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000005601', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005602', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005603', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005604', 18, 50, array['Saudi Arabia'], 100, now());
insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       18, 50, array['Saudi Arabia'], 100, now()
from generate_series(5621, 5626) n;

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (values
  ('00000000-0000-0000-0000-000000005601'::uuid),
  ('00000000-0000-0000-0000-000000005602'::uuid),
  ('00000000-0000-0000-0000-000000005603'::uuid),
  ('00000000-0000-0000-0000-000000005604'::uuid)
  ,('00000000-0000-0000-0000-000000005621'::uuid)
  ,('00000000-0000-0000-0000-000000005622'::uuid)
  ,('00000000-0000-0000-0000-000000005623'::uuid)
  ,('00000000-0000-0000-0000-000000005624'::uuid)
  ,('00000000-0000-0000-0000-000000005625'::uuid)
  ,('00000000-0000-0000-0000-000000005626'::uuid)
) member(id)
cross join halal_mode_private.legal_document_registry document
where document.is_current;

select ok(
  halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005602', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'two fully ready, mutually eligible profiles pass the shared authority'
);
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005699', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'an unready member is rejected by the shared authority'
);
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005603', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'a same-gender pair is rejected by the shared authority'
);

insert into blocks (blocker_id, blocked_id) values (
  '00000000-0000-0000-0000-000000005601',
  '00000000-0000-0000-0000-000000005602'
);
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005602', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'a blocked pair is rejected by the shared authority'
);
delete from blocks
where blocker_id = '00000000-0000-0000-0000-000000005601'
  and blocked_id = '00000000-0000-0000-0000-000000005602';

insert into halal_mode_private.pair_exposure (
  user_low, user_high, times_shown, cooldown_until
) values (
  '00000000-0000-0000-0000-000000005601',
  '00000000-0000-0000-0000-000000005602', 1, now() + interval '1 day'
);
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005602', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'a cooled-down pair is rejected by the shared authority'
);
update halal_mode_private.pair_exposure
set cooldown_until = null, retired_at = now(), retired_reason = 'test'
where user_low = '00000000-0000-0000-0000-000000005601'
  and user_high = '00000000-0000-0000-0000-000000005602';
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005601',
    '00000000-0000-0000-0000-000000005602', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'a retired pair is rejected by the shared authority'
);
delete from halal_mode_private.pair_exposure
where user_low = '00000000-0000-0000-0000-000000005601'
  and user_high = '00000000-0000-0000-0000-000000005602';

-- Backfill counts reciprocal twins once and is idempotent. An orphan half is
-- independently counted at least once.
insert into rounds (id, user_id, tier, expires_at, submitted_at) values
  ('00000000-0000-0000-0000-000000005611', '00000000-0000-0000-0000-000000005603', 'free', now() + interval '1 day', now()),
  ('00000000-0000-0000-0000-000000005612', '00000000-0000-0000-0000-000000005604', 'free', now() + interval '1 day', now());
insert into introductions (id, round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-000000005613', '00000000-0000-0000-0000-000000005611', '00000000-0000-0000-0000-000000005603', '00000000-0000-0000-0000-000000005604');
insert into introductions (id, round_id, viewer_id, subject_id, reciprocal_id) values
  ('00000000-0000-0000-0000-000000005614', '00000000-0000-0000-0000-000000005612', '00000000-0000-0000-0000-000000005604', '00000000-0000-0000-0000-000000005603', '00000000-0000-0000-0000-000000005613');
update introductions set reciprocal_id = '00000000-0000-0000-0000-000000005614'
where id = '00000000-0000-0000-0000-000000005613';

select lives_ok(
  $$select halal_mode_private.backfill_pair_exposure()$$,
  'historical introduction exposure can be backfilled'
);
select is(
  (select times_shown from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000005603'
     and user_high = '00000000-0000-0000-0000-000000005604'),
  1,
  'reciprocal twins represent one undirected appearance'
);
select lives_ok(
  $$select halal_mode_private.backfill_pair_exposure()$$,
  'the exposure backfill is safe to retry'
);
select is(
  (select times_shown from halal_mode_private.pair_exposure
   where user_low = '00000000-0000-0000-0000-000000005603'
     and user_high = '00000000-0000-0000-0000-000000005604'),
  1,
  'an idempotent backfill does not increment existing history'
);
update halal_mode_private.pair_exposure set cooldown_until = null
where user_low = '00000000-0000-0000-0000-000000005603'
  and user_high = '00000000-0000-0000-0000-000000005604';
insert into introduction_selections (
  introduction_id, viewer_id, subject_id, decision
) values (
  '00000000-0000-0000-0000-000000005613',
  '00000000-0000-0000-0000-000000005603',
  '00000000-0000-0000-0000-000000005604', 'explicit_pass'
);
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005603',
    '00000000-0000-0000-0000-000000005604', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'an explicit pass is rejected by the shared authority'
);
delete from introduction_selections
where introduction_id = '00000000-0000-0000-0000-000000005613';
delete from halal_mode_private.pair_exposure
where user_low = '00000000-0000-0000-0000-000000005603'
  and user_high = '00000000-0000-0000-0000-000000005604';
delete from introductions where id in (
  '00000000-0000-0000-0000-000000005613',
  '00000000-0000-0000-0000-000000005614'
);
delete from rounds where id in (
  '00000000-0000-0000-0000-000000005611',
  '00000000-0000-0000-0000-000000005612'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table validation_runs (mode text primary key, run_id uuid not null) on commit drop;
insert into validation_runs values
  ('live', public.matching_run_start('validation-v1', halal_mode_private.active_matching_config_version(), 5601, 'live')),
  ('shadow', public.matching_run_start('validation-v1', halal_mode_private.active_matching_config_version(), 5602, 'shadow'));

insert into connections (user_a, user_b) values
  ('00000000-0000-0000-0000-000000005603', '00000000-0000-0000-0000-000000005604');

select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005603',
    '00000000-0000-0000-0000-000000005604', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'an existing active connection is ineligible'
);
update connections set closed_at = now()
where user_a = '00000000-0000-0000-0000-000000005603'
  and user_b = '00000000-0000-0000-0000-000000005604';
select ok(
  not halal_mode_private.matching_pair_is_eligible(
    '00000000-0000-0000-0000-000000005603',
    '00000000-0000-0000-0000-000000005604', now(),
    halal_mode_private.active_matching_config_version()
  ),
  'a closed historical connection is still ineligible'
);
select ok(
  not exists (
    select 1 from public.matching_candidate_edges_service(null, null, 1000)
    where user_low = '00000000-0000-0000-0000-000000005603'
      and user_high = '00000000-0000-0000-0000-000000005604'
  ),
  'candidate retrieval excludes historical connections through the shared authority'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005603","b":"00000000-0000-0000-0000-000000005604","score":0.70,"utility":0.75}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'shadow rejects an impossible connected pair instead of recording false evidence'
);

select throws_ok(
  format(
    $$select public.persist_matching_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005603","b":"00000000-0000-0000-0000-000000005604","score":0.70,"utility":0.75}]'::jsonb,
      '[{"user_id":"00000000-0000-0000-0000-000000005603","outcome":"served"},{"user_id":"00000000-0000-0000-0000-000000005604","outcome":"served"}]'::jsonb,
      now() + interval '1 day')$$,
    (select run_id from validation_runs where mode = 'live')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'live persistence rejects the same impossible connected pair'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":0.14,"utility":0.14}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'the active minimum reciprocal score is enforced in shadow mode'
);

select throws_ok(
  format(
    $$select public.persist_matching_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":0.14,"utility":0.14}]'::jsonb,
      '[{"user_id":"00000000-0000-0000-0000-000000005601","outcome":"served"},{"user_id":"00000000-0000-0000-0000-000000005602","outcome":"served"}]'::jsonb,
      now() + interval '1 day')$$,
    (select run_id from validation_runs where mode = 'live')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'the active minimum reciprocal score is enforced in live mode'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":0.60,"utility":0.7500000001}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'even the smallest submitted amount above the exact fairness cap is rejected'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"not-a-uuid","b":"00000000-0000-0000-0000-000000005602","score":0.60,"utility":0.70}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '22023',
  'Matching edges contain malformed identifiers or scores',
  'malformed identifiers cannot enter shadow evidence'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":"NaN","utility":0.70}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'non-finite numeric scores are rejected'
);

create temporary table over_capacity_plan as
select jsonb_agg(jsonb_build_object(
  'a', '00000000-0000-0000-0000-000000005601',
  'b', '00000000-0000-0000-0000-' || lpad(n::text, 12, '0'),
  'score', 0.60,
  'utility', 0.70
) order by n) as edges
from generate_series(5621, 5626) n;
select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid, %L::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow'),
    (select edges::text from over_capacity_plan)
  ),
  '22023',
  'A matching plan exceeds member capacity',
  'shadow cannot record more edges than a member can receive'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":0.60,"utility":0.75},{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005699","score":0.60,"utility":0.70}]'::jsonb)$$,
    (select run_id from validation_runs where mode = 'shadow')
  ),
  '40001',
  'A matching edge violates eligibility or active score limits',
  'one impossible edge rejects an otherwise valid shadow set'
);
select is(
  (select count(*)::integer from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from validation_runs where mode = 'shadow')),
  0,
  'an invalid shadow set leaves no partial evidence'
);

create temporary table shadow_before as select
  (select count(*) from public.rounds) as rounds,
  (select count(*) from public.introductions) as introductions,
  (select count(*) from public.connections) as connections,
  (select count(*) from halal_mode_private.pair_exposure) as pair_exposure,
  (select count(*) from halal_mode_private.matching_member_run_outcomes) as outcomes,
  (select count(*) from halal_mode_private.notification_devices) as notifications;

select is(
  public.matching_shadow_round_service(
    (select run_id from validation_runs where mode = 'shadow'),
    '[{"a":"00000000-0000-0000-0000-000000005601","b":"00000000-0000-0000-0000-000000005602","score":0.60,"utility":0.75}]'::jsonb
  ),
  1,
  'a fully eligible bounded shadow plan persists'
);
select ok(
  (select count(*) from public.rounds) = (select rounds from shadow_before)
  and (select count(*) from public.introductions) = (select introductions from shadow_before)
  and (select count(*) from public.connections) = (select connections from shadow_before)
  and (select count(*) from halal_mode_private.pair_exposure) = (select pair_exposure from shadow_before)
  and (select count(*) from halal_mode_private.matching_member_run_outcomes) = (select outcomes from shadow_before)
  and (select count(*) from halal_mode_private.notification_devices) = (select notifications from shadow_before),
  'validated shadow persistence still mutates no live matching or notification state'
);
select is(
  (select count(*)::integer from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from validation_runs where mode = 'shadow')),
  2,
  'the valid shadow pair is stored only as two directed shadow rows'
);

select ok(
  position('introductions' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('connections' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('pair_exposure' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('notification' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0,
  'the public shadow writer has no live write target in its function body'
);

select ok(
  not has_function_privilege('service_role',
    'halal_mode_private.matching_pair_is_eligible(uuid,uuid,timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'halal_mode_private.validate_matching_edges(uuid,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'halal_mode_private.validate_matching_edges(uuid,jsonb,timestamptz)', 'EXECUTE'),
  'private validation details are reachable only through service facades'
);

select * from finish();
rollback;
