begin;
set local search_path = public, extensions;
select plan(42);

select has_table(
  'halal_mode_private', 'matching_run_member_snapshots',
  'matching runs have a private member snapshot table'
);
select has_table(
  'halal_mode_private', 'matching_run_candidate_snapshots',
  'matching runs have a private candidate snapshot table'
);
select ok(
  has_function_privilege('service_role', 'public.matching_run_start_service(text,integer,bigint,text,date,timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_candidate_snapshot_prepare_service(uuid,bigint)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_candidate_edges_service(uuid,uuid,uuid,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_member_signals_service(uuid)', 'EXECUTE'),
  'service role can use the run-bound snapshot boundary'
);
select ok(
  not has_function_privilege('authenticated', 'public.matching_run_start_service(text,integer,bigint,text,date,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_candidate_snapshot_prepare_service(uuid,bigint)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_candidate_edges_service(uuid,uuid,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_member_signals_service(uuid)', 'EXECUTE'),
  'ordinary members cannot execute the snapshot boundary'
);
select ok(
  not has_table_privilege('service_role', 'halal_mode_private.matching_run_member_snapshots', 'SELECT')
  and not has_table_privilege('service_role', 'halal_mode_private.matching_run_candidate_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_run_member_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_run_candidate_snapshots', 'SELECT'),
  'snapshot rows are reachable only through the narrow service functions'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005701', 'snapshot-m1@example.test'),
  ('00000000-0000-0000-0000-000000005702', 'snapshot-m2@example.test'),
  ('00000000-0000-0000-0000-000000005703', 'snapshot-f1@example.test'),
  ('00000000-0000-0000-0000-000000005704', 'snapshot-f2@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005701', 'Snapshot M1', 'M1', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['m1.jpg'], true),
  ('00000000-0000-0000-0000-000000005702', 'Snapshot M2', 'M2', '1990-02-01', 'male', 'Madinah', 'Saudi Arabia', 24.4675, 39.6027, repeat('b', 50), array['m2.jpg'], true),
  ('00000000-0000-0000-0000-000000005703', 'Snapshot F1', 'F1', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('c', 50), array['f1.jpg'], true),
  ('00000000-0000-0000-0000-000000005704', 'Snapshot F2', 'F2', '1991-02-01', 'female', 'Madinah', 'Saudi Arabia', 24.4682, 39.6032, repeat('d', 50), array['f2.jpg'], true);

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000005701', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005702', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005703', 18, 50, array['Saudi Arabia'], 100, now()),
  ('00000000-0000-0000-0000-000000005704', 18, 50, array['Saudi Arabia'], 100, now());

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (values
  ('00000000-0000-0000-0000-000000005701'::uuid),
  ('00000000-0000-0000-0000-000000005702'::uuid),
  ('00000000-0000-0000-0000-000000005703'::uuid),
  ('00000000-0000-0000-0000-000000005704'::uuid)
) member(id)
cross join halal_mode_private.legal_document_registry document
where document.is_current;

-- One exposure is immediately before the fixed window and one is on its
-- first day. Only the latter may contribute to the frozen fairness signal.
insert into rounds (
  id, user_id, tier, opens_at, expires_at, submitted_at
) values
  ('00000000-0000-0000-0000-000000005711', '00000000-0000-0000-0000-000000005701', 'free', '2026-07-29 12:00 Asia/Riyadh', '2026-07-29 20:00 Asia/Riyadh', '2026-07-29 13:00 Asia/Riyadh'),
  ('00000000-0000-0000-0000-000000005712', '00000000-0000-0000-0000-000000005701', 'free', '2026-07-30 12:00 Asia/Riyadh', '2026-07-30 20:00 Asia/Riyadh', '2026-07-30 13:00 Asia/Riyadh');
insert into introductions (round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-000000005711', '00000000-0000-0000-0000-000000005701', '00000000-0000-0000-0000-000000005703'),
  ('00000000-0000-0000-0000-000000005712', '00000000-0000-0000-0000-000000005701', '00000000-0000-0000-0000-000000005703');

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000005700","role":"service_role"}',
  true
);

create temporary table snapshot_test_runs (
  label text primary key,
  context jsonb not null
) on commit drop;

insert into snapshot_test_runs values
  ('first', public.matching_run_start_service('snapshot-v1', halal_mode_private.active_matching_config_version(), 5701, 'live', '2026-07-30', '2026-07-30 04:30 Asia/Riyadh')),
  ('last', public.matching_run_start_service('snapshot-v1', halal_mode_private.active_matching_config_version(), 5702, 'live', '2026-08-05', '2026-08-05 04:35 Asia/Riyadh')),
  ('live', public.matching_run_start_service('snapshot-v1', halal_mode_private.active_matching_config_version(), 5703, 'live', '2026-08-01', '2026-08-01 04:32 Asia/Riyadh')),
  ('shadow', public.matching_run_start_service('snapshot-v1', halal_mode_private.active_matching_config_version(), 9999, 'shadow', '2026-08-01', '2026-08-01 04:32 Asia/Riyadh'));

select ok(
  (select context ?& array[
    'run_id', 'seed', 'cycle_date', 'time_zone', 'window_starts_on',
    'window_ends_on', 'rounds_elapsed_in_window', 'evaluated_at',
    'pool_member_count'
  ] from snapshot_test_runs where label = 'first'),
  'run start returns the complete frozen context contract'
);
select is(
  (select context ->> 'window_starts_on' from snapshot_test_runs where label = 'first'),
  '2026-07-30', 'the first calendar day starts a new seven-day window'
);
select is(
  (select context ->> 'window_ends_on' from snapshot_test_runs where label = 'first'),
  '2026-08-05', 'the first calendar day has the fixed inclusive window end'
);
select is(
  (select (context ->> 'rounds_elapsed_in_window')::integer from snapshot_test_runs where label = 'first'),
  1, 'the first calendar day is round one of the fairness window'
);
select is(
  (select context ->> 'window_starts_on' from snapshot_test_runs where label = 'last'),
  '2026-07-30', 'the last calendar day retains the same window start'
);
select is(
  (select context ->> 'window_ends_on' from snapshot_test_runs where label = 'last'),
  '2026-08-05', 'the last calendar day retains the same window end'
);
select is(
  (select (context ->> 'rounds_elapsed_in_window')::integer from snapshot_test_runs where label = 'last'),
  7, 'the last calendar day is round seven of the fairness window'
);
select is(
  (select jsonb_build_array(
     context ->> 'cycle_date', context ->> 'time_zone',
     context ->> 'window_starts_on', context ->> 'window_ends_on',
     context ->> 'rounds_elapsed_in_window', context ->> 'evaluated_at'
   ) from snapshot_test_runs where label = 'live'),
  (select jsonb_build_array(
     context ->> 'cycle_date', context ->> 'time_zone',
     context ->> 'window_starts_on', context ->> 'window_ends_on',
     context ->> 'rounds_elapsed_in_window', context ->> 'evaluated_at'
   ) from snapshot_test_runs where label = 'shadow'),
  'live and shadow runs for one cycle receive identical calendar inputs'
);
select throws_ok(
  $$select public.matching_run_start_service(
      'snapshot-v1', 1, 5705, 'live', '2026-08-01',
      '2026-08-02 00:01 Asia/Riyadh'
    )$$,
  '22023', 'Matching evaluation time must fall on the cycle date in Riyadh',
  'a canonical evaluation instant cannot belong to another Riyadh date'
);

select throws_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 2)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '55000', 'Prepare the matching candidate snapshot before paging it',
  'candidate pages cannot load before the hard guard runs'
);
select throws_ok(
  format(
    'select public.matching_candidate_snapshot_prepare_service(%L::uuid, 3)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '54000', 'Potential candidate edge count 4 exceeds fail limit 3',
  'the cheap potential-edge guard fails before unsafe materialization'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots c
    where c.run_id = (
      select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'
    )
  ) and (
    select candidate_snapshot_prepared_at is null
    from halal_mode_private.matching_runs
    where id = (
      select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'
    )
  ),
  'a failed guard leaves no partial candidate rows or prepared marker'
);

create temporary table snapshot_prepare_result as
select public.matching_candidate_snapshot_prepare_service(
  (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'),
  4
) as result;

select is(
  (select (result ->> 'candidate_edge_count')::bigint from snapshot_prepare_result),
  4::bigint, 'all four mutually eligible edges are materialized once'
);
select is(
  (select (result ->> 'potential_edge_count')::bigint from snapshot_prepare_result),
  4::bigint, 'the potential-edge count is the cheap two-by-two pool product'
);
select is(
  public.matching_candidate_snapshot_prepare_service(
    (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'), 4
  ),
  (select result from snapshot_prepare_result),
  'an exact snapshot preparation retry returns the identical result'
);
select throws_ok(
  format(
    'select public.matching_candidate_snapshot_prepare_service(%L::uuid, 5)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '40001', 'A prepared matching snapshot cannot change its fail limit',
  'a retry cannot silently change the preparation contract'
);
select ok(
  (select (select count(*) from jsonb_each(to_jsonb(edge))) = 9
    and to_jsonb(edge) ?& array[
    'user_low', 'user_high', 'compat_low_to_high', 'compat_high_to_low',
    'pair_times_shown', 'pair_first_score', 'pair_last_score',
    'pair_cooldown_until', 'pair_retired_at'
  ]
   from public.matching_candidate_edges_service(
     (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'),
     null, null, 1
   ) edge),
  'candidate pages expose exactly the documented nine server-only fields'
);

create temporary table snapshot_pages as
select * from public.matching_candidate_edges_service(
  (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'),
  null, null, 2
);
insert into snapshot_pages
select * from public.matching_candidate_edges_service(
  (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'),
  (select user_low from snapshot_pages order by user_low desc, user_high desc limit 1),
  (select user_high from snapshot_pages order by user_low desc, user_high desc limit 1),
  2
);
select is((select count(*)::integer from snapshot_pages), 4,
  'two deterministic pages cover the whole frozen candidate set');
select is(
  (select count(*)::integer from (select distinct user_low, user_high from snapshot_pages) d),
  4, 'stable cursor pages return every candidate exactly once'
);
select results_eq(
  format(
    'select user_low, user_high from public.matching_candidate_edges_service(%L::uuid, null, null, 2)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  format(
    'select user_low, user_high from public.matching_candidate_edges_service(%L::uuid, null, null, 2)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  're-reading a candidate page is deterministic'
);

select lives_ok(
  format(
    'select public.matching_candidate_snapshot_prepare_service(%L::uuid, 4)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'first')
  ),
  'the first-day run snapshot prepares successfully'
);
select is(
  (select exposures_in_window
   from public.matching_member_signals_service(
     (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'first')
   ) where user_id = '00000000-0000-0000-0000-000000005701'),
  1, 'the prior-window exposure is excluded and the first-day exposure remains'
);

insert into blocks (blocker_id, blocked_id) values (
  '00000000-0000-0000-0000-000000005701',
  '00000000-0000-0000-0000-000000005703'
);
update profiles set is_paused = true
where id = '00000000-0000-0000-0000-000000005704';
select is(
  (select count(*)::integer
   from public.matching_candidate_edges_service(
     (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'),
     null, null, 100
   )),
  4, 'source eligibility changes after preparation do not mutate candidate pages'
);
select results_eq(
  format(
    'select user_low, user_high from public.matching_candidate_edges_service(%L::uuid, null, null, 100)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  $$select user_low, user_high from snapshot_pages order by user_low, user_high$$,
  'source changes preserve the identities and order of every frozen edge'
);
select is(
  (select count(*)::integer
   from public.matching_member_signals_service(
     (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live')
   )),
  4, 'source pool changes after preparation do not mutate member signals'
);

insert into rounds (
  id, user_id, tier, opens_at, expires_at, submitted_at
) values (
  '00000000-0000-0000-0000-000000005713',
  '00000000-0000-0000-0000-000000005701', 'free',
  '2026-07-31 12:00 Asia/Riyadh', '2026-07-31 20:00 Asia/Riyadh',
  '2026-07-31 13:00 Asia/Riyadh'
);
insert into introductions (round_id, viewer_id, subject_id) values (
  '00000000-0000-0000-0000-000000005713',
  '00000000-0000-0000-0000-000000005701',
  '00000000-0000-0000-0000-000000005704'
);
select is(
  (select exposures_in_window
   from public.matching_member_signals_service(
     (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'first')
   ) where user_id = '00000000-0000-0000-0000-000000005701'),
  1, 'new source exposures after preparation do not change frozen fairness inputs'
);
select ok(
  (select candidate_edge_count = 4 and potential_edge_count = 4
     and candidate_edge_count = (
       select count(*) from halal_mode_private.matching_run_candidate_snapshots c
       where c.run_id = r.id
     )
   from halal_mode_private.matching_runs r
   where r.id = (
     select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'live'
   )),
  'stored preparation metrics agree with the immutable snapshot rows'
);

select throws_ok(
  $$select public.matching_candidate_snapshot_prepare_service(
      '00000000-0000-0000-0000-000000005799', 10
    )$$,
  '22023', 'A snapshot-capable matching run is required',
  'snapshot preparation rejects an unknown run'
);
select throws_ok(
  $$select * from public.matching_candidate_edges_service(
      '00000000-0000-0000-0000-000000005799', null, null, 10
    )$$,
  '22023', 'A snapshot-capable matching run is required',
  'candidate paging rejects an unknown run'
);
select throws_ok(
  $$select * from public.matching_member_signals_service(
      '00000000-0000-0000-0000-000000005799'
    )$$,
  '22023', 'A snapshot-capable matching run is required',
  'member signal reads reject an unknown run'
);

select public.matching_candidate_snapshot_prepare_service(
  (select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'shadow'), 4
);
update halal_mode_private.matching_runs set finished_at = now()
where id = (
  select (context ->> 'run_id')::uuid from snapshot_test_runs where label = 'shadow'
);
select throws_ok(
  format(
    'select public.matching_candidate_snapshot_prepare_service(%L::uuid, 4)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'shadow')
  ),
  '22023', 'A finished matching run cannot prepare candidates',
  'snapshot preparation rejects a finished run'
);
select throws_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 10)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'shadow')
  ),
  '22023', 'A finished matching run cannot read candidates',
  'candidate paging rejects a finished run'
);
select throws_ok(
  format(
    'select * from public.matching_member_signals_service(%L::uuid)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'shadow')
  ),
  '22023', 'A finished matching run cannot read member signals',
  'member signal reads reject a finished run'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000005701","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.matching_run_start_service(
      'snapshot-v1', 1, 1, 'live', '2026-08-01',
      '2026-08-01 04:32 Asia/Riyadh'
    )$$,
  '42501', 'Matching run creation requires service role',
  'an authenticated member cannot start a matching run'
);
select throws_ok(
  format(
    'select public.matching_candidate_snapshot_prepare_service(%L::uuid, 4)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '42501', 'Matching snapshot preparation requires service role',
  'an authenticated member cannot prepare candidate snapshots'
);
select throws_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 2)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '42501', 'Matching candidates require service role',
  'an authenticated member cannot read candidate pages'
);
select throws_ok(
  format(
    'select * from public.matching_member_signals_service(%L::uuid)',
    (select context ->> 'run_id' from snapshot_test_runs where label = 'live')
  ),
  '42501', 'Matching member signals require service role',
  'an authenticated member cannot read private member signals'
);

select * from finish();
rollback;
