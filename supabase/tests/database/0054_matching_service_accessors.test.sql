begin;

set local search_path = public, extensions;
select plan(27);

-- The facade is callable only by the backend service. Possessing an ordinary
-- member JWT must not reveal weights, candidate scores, private preferences,
-- queue position, or shadow output.
select ok(
  has_function_privilege('service_role', 'public.matching_run_config()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.release_flag_active(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_run_start(text,integer,bigint,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_run_finish(uuid,integer,integer,integer,integer,jsonb,bigint,jsonb,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_candidate_edges_service(uuid,uuid,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_member_signals_service()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.persist_matching_round_service(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_shadow_round_service(uuid,jsonb)', 'EXECUTE'),
  'service role can call the complete narrow matching facade'
);

select ok(
  not has_function_privilege('anon', 'public.matching_run_config()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.matching_candidate_edges_service(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.matching_member_signals_service()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.persist_matching_round_service(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.matching_shadow_round_service(uuid,jsonb)', 'EXECUTE'),
  'anonymous callers cannot use the matching facade'
);

select ok(
  not has_function_privilege('authenticated', 'public.matching_run_config()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_run_start(text,integer,bigint,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_run_finish(uuid,integer,integer,integer,integer,jsonb,bigint,jsonb,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_candidate_edges_service(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_member_signals_service()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.persist_matching_round_service(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_shadow_round_service(uuid,jsonb)', 'EXECUTE'),
  'authenticated callers cannot use the matching facade'
);

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.matching_config', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_runs', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_member_run_outcomes', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.shadow_round_edges', 'SELECT')
  and not has_table_privilege('authenticated', 'public.selection_scores', 'SELECT')
  and not has_table_privilege('authenticated', 'public.private_preferences', 'SELECT'),
  'matching configuration, outcomes, scores, and preferences remain private'
);

select ok(
  not has_function_privilege('service_role', 'halal_mode_private.matching_candidate_edges(uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'halal_mode_private.matching_member_signals()', 'EXECUTE')
  and not has_function_privilege('service_role', 'halal_mode_private.persist_matching_round(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE'),
  'service role reaches matching internals only through the public facade'
);

select is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'matching_run_config', 'release_flag_active', 'matching_run_start',
        'matching_run_finish', 'matching_candidate_edges_service',
        'matching_member_signals_service', 'persist_matching_round_service',
        'matching_shadow_round_service'
      ])
      and p.prosecdef
      and position('auth.role()' in pg_get_functiondef(p.oid)) > 0
  ),
  8,
  'all eight matching facade functions are SECURITY DEFINER and check the JWT role'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000005400","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.matching_run_config()$$,
  '42501',
  'Matching service access requires service role',
  'the config accessor enforces role inside its SECURITY DEFINER body'
);

select throws_ok(
  $$select public.matching_shadow_round_service(
      '00000000-0000-0000-0000-000000005400', '[]'::jsonb
    )$$,
  '42501',
  'Shadow persistence requires service role',
  'the shadow writer enforces role inside its SECURITY DEFINER body'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000005400","role":"service_role"}',
  true
);

select is(
  (public.matching_run_config() ->> '__version')::integer,
  halal_mode_private.active_matching_config_version(),
  'the service reads the active config and its exact version together'
);

select throws_ok(
  $$select public.matching_run_start(
      'reciprocal-v1', 999999, 5400, 'shadow'
    )$$,
  '22023',
  'Matching run must use the active configuration version',
  'a run cannot claim an inactive or nonexistent config version'
);

select throws_ok(
  $$select * from public.matching_candidate_edges_service(
      null, '00000000-0000-0000-0000-000000005401', 100
    )$$,
  '22023',
  'Both matching candidate cursors must be provided together',
  'candidate pagination rejects a half cursor'
);

select throws_ok(
  $$select * from public.matching_candidate_edges_service(null, null, 1001)$$,
  '22023',
  'Matching candidate page size must be between 1 and 1000',
  'candidate pagination is bounded to one thousand edges'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005401', 'shadow-a@example.test'),
  ('00000000-0000-0000-0000-000000005402', 'shadow-b@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005401', 'Shadow A', 'Shadow', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['a.jpg'], true),
  ('00000000-0000-0000-0000-000000005402', 'Shadow B', 'Shadow', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('b', 50), array['b.jpg'], true);

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000005401', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005402', 18, 50, array['Saudi Arabia'], 100, now());

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (values
  ('00000000-0000-0000-0000-000000005401'::uuid),
  ('00000000-0000-0000-0000-000000005402'::uuid)
) member(id)
cross join halal_mode_private.legal_document_registry document
where document.is_current;

create temporary table matching_test_runs (
  mode text primary key,
  run_id uuid not null
) on commit drop;

insert into matching_test_runs (mode, run_id)
values (
  'shadow',
  public.matching_run_start(
    'reciprocal-v1', halal_mode_private.active_matching_config_version(),
    5401, 'shadow'
  )
), (
  'live',
  public.matching_run_start(
    'reciprocal-v1', halal_mode_private.active_matching_config_version(),
    5402, 'live'
  )
);

create temporary table matching_live_counts as
select
  (select count(*) from public.rounds) as rounds,
  (select count(*) from public.introductions) as introductions,
  (select count(*) from public.connections) as connections,
  (select count(*) from halal_mode_private.pair_exposure) as pair_exposure,
  (select count(*) from halal_mode_private.matching_member_run_outcomes) as outcomes,
  (select count(*) from halal_mode_private.notification_devices) as notifications;

select is(
  public.matching_shadow_round_service(
    (select run_id from matching_test_runs where mode = 'shadow'),
    jsonb_build_array(jsonb_build_object(
      'a', '00000000-0000-0000-0000-000000005401',
      'b', '00000000-0000-0000-0000-000000005402',
      'score', 0.72,
      'utility', 0.81
    ))
  ),
  1,
  'one undirected shadow pair is accepted'
);

select is(
  (select count(*)::integer
   from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from matching_test_runs where mode = 'shadow')),
  2,
  'a shadow pair is persisted as two reciprocal directed rows'
);

select ok(
  exists (
    select 1
    from halal_mode_private.shadow_round_edges
    where run_id = (select run_id from matching_test_runs where mode = 'shadow')
      and viewer_id = '00000000-0000-0000-0000-000000005401'
      and subject_id = '00000000-0000-0000-0000-000000005402'
      and reciprocal_score = 0.72
      and adjusted_utility = 0.81
  ) and exists (
    select 1
    from halal_mode_private.shadow_round_edges
    where run_id = (select run_id from matching_test_runs where mode = 'shadow')
      and viewer_id = '00000000-0000-0000-0000-000000005402'
      and subject_id = '00000000-0000-0000-0000-000000005401'
      and reciprocal_score = 0.72
      and adjusted_utility = 0.81
  ),
  'both shadow directions preserve the score and adjusted utility'
);

select ok(
  (select count(*) from public.rounds) = (select rounds from matching_live_counts)
  and (select count(*) from public.introductions) = (select introductions from matching_live_counts)
  and (select count(*) from public.connections) = (select connections from matching_live_counts)
  and (select count(*) from halal_mode_private.pair_exposure) = (select pair_exposure from matching_live_counts)
  and (select count(*) from halal_mode_private.matching_member_run_outcomes) = (select outcomes from matching_live_counts)
  and (select count(*) from halal_mode_private.notification_devices) = (select notifications from matching_live_counts),
  'shadow persistence does not mutate rounds, introductions, connections, exposure, outcomes, or notifications'
);

select is(
  public.matching_shadow_round_service(
    (select run_id from matching_test_runs where mode = 'shadow'),
    '[{"a":"00000000-0000-0000-0000-000000005401","b":"00000000-0000-0000-0000-000000005402","score":0.72,"utility":0.81}]'::jsonb
  ),
  1,
  'an identical shadow retry is idempotent'
);

select is(
  (select count(*)::integer
   from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from matching_test_runs where mode = 'shadow')),
  2,
  'an idempotent retry does not duplicate shadow rows'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005401","b":"00000000-0000-0000-0000-000000005402","score":0.73,"utility":0.81}]'::jsonb)$$,
    (select run_id from matching_test_runs where mode = 'shadow')
  ),
  '22023',
  'Shadow run output cannot be changed after it is written',
  'a retry cannot rewrite the evidence recorded for a run'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid, '[]'::jsonb)$$,
    (select run_id from matching_test_runs where mode = 'live')
  ),
  '22023',
  'An unfinished shadow run is required',
  'the shadow writer rejects a live run'
);

select throws_ok(
  format(
    $$select public.persist_matching_round_service(
      %L::uuid, '[]'::jsonb, '[]'::jsonb, now() + interval '1 day'
    )$$,
    (select run_id from matching_test_runs where mode = 'shadow')
  ),
  '22023',
  'An unfinished live run is required',
  'the live writer rejects a shadow run'
);

select lives_ok(
  format(
    $$select public.matching_run_finish(
      %L::uuid, 2, 1, 0, 0, '{"fetch":5}'::jsonb, 1024, '[]'::jsonb, null
    )$$,
    (select run_id from matching_test_runs where mode = 'shadow')
  ),
  'a shadow run can record successful completion metrics'
);

select ok(
  exists (
    select 1
    from halal_mode_private.matching_runs
    where id = (select run_id from matching_test_runs where mode = 'shadow')
      and finished_at is not null
      and eligible_members = 2
      and edges_after_filter = 1
      and stage_latencies = '{"fetch":5}'::jsonb
      and error is null
  ),
  'run completion stores the supplied metrics on the same private run'
);

select lives_ok(
  format(
    $$select public.matching_run_finish(
      %L::uuid, 2, 0, 0, 0, '{"fetch":9}'::jsonb, 2048,
      '["candidate_fetch_failed"]'::jsonb, 'candidate fetch failed'
    )$$,
    (select run_id from matching_test_runs where mode = 'live')
  ),
  'a failed run can record its error and partial metrics'
);

select ok(
  exists (
    select 1
    from halal_mode_private.matching_runs
    where id = (select run_id from matching_test_runs where mode = 'live')
      and finished_at is not null
      and error = 'candidate fetch failed'
      and peak_memory_bytes = 2048
      and threshold_breaches = '["candidate_fetch_failed"]'::jsonb
  ),
  'error completion preserves the diagnostic metrics and bounded error text'
);

select throws_ok(
  format(
    $$select public.matching_shadow_round_service(%L::uuid, '[]'::jsonb)$$,
    (select run_id from matching_test_runs where mode = 'shadow')
  ),
  '22023',
  'An unfinished matching run is required',
  'finished shadow output is immutable'
);

select ok(
  position('public.introductions' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('public.connections' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('pair_exposure' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('notification' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0
  and position('matching_member_run_outcomes' in pg_get_functiondef(
    'public.matching_shadow_round_service(uuid,jsonb)'::regprocedure
  )) = 0,
  'the shadow function body has no live matching or notification write target'
);

select * from finish();
rollback;
