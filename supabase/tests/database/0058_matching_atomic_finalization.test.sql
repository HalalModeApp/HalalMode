begin;
set local search_path = public, extensions;
select plan(32);

select ok(
  has_function_privilege('service_role', 'public.matching_live_finalize_service(uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,bigint,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.persist_matching_round_service(uuid,jsonb,jsonb,timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.matching_shadow_round_service(uuid,jsonb)', 'EXECUTE'),
  'service role has only the atomic successful finalization boundary'
);
select ok(
  not has_function_privilege('authenticated', 'public.matching_live_finalize_service(uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,bigint,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)', 'EXECUTE'),
  'member roles cannot finalize matching runs'
);
select ok(
  not has_table_privilege('service_role', 'halal_mode_private.matching_run_rounds', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_run_rounds', 'SELECT'),
  'run-to-round provenance remains private behind the service facade'
);

insert into auth.users (id, email)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'atomic-' || n || '@example.test'
from generate_series(5801, 5806) n;

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'Atomic ' || n, 'Atomic',
  case when n % 2 = 1 then '1990-01-01'::date else '1991-01-01'::date end,
  case when n % 2 = 1 then 'male'::gender else 'female'::gender end,
  'Madinah', 'Saudi Arabia', 24.4670 + ((n - 5800)::numeric / 10000),
  39.6024, repeat('a', 50), array['atomic.jpg'], true
from generate_series(5801, 5806) n;

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       18, 50, array['Saudi Arabia'], 100, now()
from generate_series(5801, 5806) n;

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id
  from generate_series(5801, 5806) n
) member
cross join halal_mode_private.legal_document_registry document
where document.is_current;

-- A/B will reach the repeat limit on this live appearance. C/D has declined
-- far enough from its first score to support a score-collapse retirement.
insert into halal_mode_private.pair_exposure (
  user_low, user_high, times_shown, first_reciprocal_score,
  last_reciprocal_score, cooldown_until
) values
  ('00000000-0000-0000-0000-000000005801', '00000000-0000-0000-0000-000000005802', 2, 0.75, 0.70, null),
  ('00000000-0000-0000-0000-000000005803', '00000000-0000-0000-0000-000000005804', 1, 0.90, 0.60, null);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table atomic_runs (
  name text primary key,
  run_id uuid not null
) on commit drop;
insert into atomic_runs values
  ('live', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5801,
    'live', '2026-08-01', '2026-08-01 05:00+03'
  ) ->> 'run_id')::uuid),
  ('shadow', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5801,
    'shadow', '2026-08-01', '2026-08-01 05:00+03'
  ) ->> 'run_id')::uuid),
  ('invalid', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5802,
    'live', '2026-08-03', '2026-08-03 05:00+03'
  ) ->> 'run_id')::uuid),
  ('failed', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5803,
    'live', '2026-08-01', '2026-08-01 05:00+03'
  ) ->> 'run_id')::uuid),
  ('contradict', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5804,
    'live', '2026-08-01', '2026-08-01 05:00+03'
  ) ->> 'run_id')::uuid),
  ('second', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5805,
    'live', '2026-08-01', '2026-08-01 05:00+03'
  ) ->> 'run_id')::uuid),
  ('past', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5806,
    'live', '2026-08-02', '2026-08-02 05:00+03'
  ) ->> 'run_id')::uuid),
  ('blocked', (public.matching_run_start_service(
    'atomic-v1', halal_mode_private.active_matching_config_version(), 5807,
    'live', '2026-08-04', '2026-08-04 05:00+03'
  ) ->> 'run_id')::uuid);

select lives_ok(
  $$select public.matching_candidate_snapshot_prepare_service(run_id, 100)
    from atomic_runs$$,
  'all atomic-finalization runs prepare immutable snapshots first'
);

create temporary table live_payload as
select
  '[{"a":"00000000-0000-0000-0000-000000005801","b":"00000000-0000-0000-0000-000000005802","score":0.70,"utility":0.80}]'::jsonb as edges,
  (
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'outcome', case when m.user_id in (
        '00000000-0000-0000-0000-000000005801'::uuid,
        '00000000-0000-0000-0000-000000005802'::uuid
      ) then 'served' else 'no_candidate' end
    ) order by m.user_id)
    from halal_mode_private.matching_run_member_snapshots m
    where m.run_id = (select run_id from atomic_runs where name = 'live')
  ) as outcomes,
  '[{"user_low":"00000000-0000-0000-0000-000000005803","user_high":"00000000-0000-0000-0000-000000005804","reason":"score_collapse","current_score":0.50}]'::jsonb as retirements,
  now() + interval '1 day' as expires_at;

-- Ordinary preference drift after the frozen snapshot does not make earlier
-- candidate pages disagree with later finalization.
update private_preferences set min_age = 50, max_age = 60
where user_id = '00000000-0000-0000-0000-000000005802';

create temporary table live_result as
select public.matching_live_finalize_service(
  (select run_id from atomic_runs where name = 'live'),
  edges, outcomes, retirements, expires_at,
  '{"fetch":4,"allocate":2}'::jsonb, 4096, '[]'::jsonb
) as result
from live_payload;

select ok(
  (select (result ->> 'idempotent')::boolean is false
          and (result ->> 'pairs_created')::integer = 1
          and (result ->> 'rounds_created')::integer = 2
   from live_result),
  'first live finalization survives ordinary post-snapshot preference drift and returns derived counts'
);
select ok(
  exists (
    select 1 from halal_mode_private.matching_runs r
    where r.id = (select run_id from atomic_runs where name = 'live')
      and r.finished_at is not null and r.error is null
      and r.pairs_created = 1 and r.rounds_created = 2
      and r.eligible_members = 6 and r.edges_after_filter = 9
      and r.finalization_hash is not null
  ),
  'the live run stores authoritative snapshot and write-derived metrics'
);
select is(
  (select count(*)::integer from halal_mode_private.matching_run_rounds
   where run_id = (select run_id from atomic_runs where name = 'live')),
  2,
  'both generated member rounds are linked to the live run'
);
select ok(
  exists (
    select 1 from introductions a
    join introductions b on b.id = a.reciprocal_id and b.reciprocal_id = a.id
    where a.viewer_id = '00000000-0000-0000-0000-000000005801'
      and a.subject_id = '00000000-0000-0000-0000-000000005802'
  ),
  'live finalization stores exactly linked reciprocal twins'
);
select ok(
  exists (
    select 1 from halal_mode_private.pair_exposure
    where user_low = '00000000-0000-0000-0000-000000005801'
      and user_high = '00000000-0000-0000-0000-000000005802'
      and times_shown = 3 and retired_at is not null
      and retired_reason = 'repeat_limit'
  ),
  'the appearance that reaches the repeat limit retires atomically'
);
select ok(
  exists (
    select 1 from halal_mode_private.pair_exposure
    where user_low = '00000000-0000-0000-0000-000000005803'
      and user_high = '00000000-0000-0000-0000-000000005804'
      and retired_at is not null and retired_reason = 'score_collapse'
  ),
  'a supported score-collapse proposal is durably retired only by live finalization'
);

select ok(
  (
    select (public.matching_live_finalize_service(
      (select run_id from atomic_runs where name = 'live'),
      edges,
      (select jsonb_agg(value order by (value ->> 'user_id')::uuid desc)
       from jsonb_array_elements(outcomes) value),
      retirements, expires_at, '{"fetch":4,"allocate":2}'::jsonb, 4096, '[]'::jsonb
    ) ->> 'idempotent')::boolean
    from live_payload
  ),
  'an exact live retry is canonical across outcome ordering and reports idempotence'
);
select ok(
  (select count(*) from introductions i
   join halal_mode_private.matching_run_rounds rr on rr.round_id = i.round_id
   where rr.run_id = (select run_id from atomic_runs where name = 'live')) = 2
  and (select count(*) from halal_mode_private.matching_run_rounds
       where run_id = (select run_id from atomic_runs where name = 'live')) = 2,
  'a lost-response retry creates no duplicate cards or rounds'
);
select throws_ok(
  format(
    $$select public.matching_live_finalize_service(%L::uuid, %L::jsonb, %L::jsonb,
      %L::jsonb, %L::timestamptz, '{"fetch":5}'::jsonb, 4096, '[]'::jsonb)$$,
    (select run_id from atomic_runs where name = 'live'),
    (select edges::text from live_payload),
    (select outcomes::text from live_payload),
    (select retirements::text from live_payload),
    (select expires_at::text from live_payload)
  ),
  '40001',
  'A finished live run cannot be finalized with a different request',
  'a conflicting live retry cannot rewrite authoritative truth'
);
select throws_ok(
  format(
    $$select public.matching_run_finish(%L::uuid, null, null, null, null,
      '{}'::jsonb, 1, '[]'::jsonb, 'overwrite')$$,
    (select run_id from atomic_runs where name = 'live')
  ),
  '40001',
  'A successful or finished run cannot be overwritten',
  'the failure recorder cannot overwrite a successful live run'
);

select throws_ok(
  format(
    $$select public.matching_live_finalize_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005806","score":0.70,"utility":0.80}]'::jsonb,
      %L::jsonb, '[]'::jsonb, now() + interval '1 day', '{}'::jsonb, 1, '[]'::jsonb)$$,
    (select run_id from atomic_runs where name = 'second'),
    (select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'outcome', case when m.user_id in (
        '00000000-0000-0000-0000-000000005805'::uuid,
        '00000000-0000-0000-0000-000000005806'::uuid
      ) then 'served' else 'no_candidate' end
    ))::text
    from halal_mode_private.matching_run_member_snapshots m
    where m.run_id = (select run_id from atomic_runs where name = 'second'))
  ),
  '23505',
  'This cycle already has a successful live matching run',
  'a second distinct live run cannot succeed for the same cycle'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_rounds
    where run_id = (select run_id from atomic_runs where name = 'second')
  ) and exists (
    select 1 from halal_mode_private.matching_runs
    where id = (select run_id from atomic_runs where name = 'second')
      and finished_at is null
  ),
  'the rejected second live run rolls back without creating rounds'
);

-- Simulate a response that was lost before the client retried after expiry.
-- The stored canonical hash must win before first-attempt expiry validation.
update halal_mode_private.matching_runs r
set finished_at = now(),
    finalization_hash = halal_mode_private.matching_finalize_hash(
      'live', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      '2026-07-31 00:00+03', '{}'::jsonb, 0, '[]'::jsonb
    ),
    finalization_result = '{"pairs_created":0,"rounds_created":0,"eligible_members":6,"edges_after_filter":9}'::jsonb,
    pairs_created = 0, rounds_created = 0, eligible_members = 6, edges_after_filter = 9
where r.id = (select run_id from atomic_runs where name = 'past');
select ok(
  (public.matching_live_finalize_service(
    (select run_id from atomic_runs where name = 'past'),
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '2026-07-31 00:00+03',
    '{}'::jsonb, 0, '[]'::jsonb
  ) ->> 'idempotent')::boolean,
  'an exact lost-response retry remains idempotent after its expiry has passed'
);

-- A newly eligible pair created after snapshot preparation must not be
-- smuggled into a frozen plan.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005899', 'atomic-late@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values (
  '00000000-0000-0000-0000-000000005899', 'Atomic Late', 'Late',
  '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4688, 39.6033,
  repeat('l', 50), array['late.jpg'], true
);
insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
) values (
  '00000000-0000-0000-0000-000000005899', 18, 50,
  array['Saudi Arabia'], 100, now()
);
insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select '00000000-0000-0000-0000-000000005899', document_type, version, 'onboarding'
from halal_mode_private.legal_document_registry where is_current;

select throws_ok(
  format(
    $$select public.matching_live_finalize_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005899","score":0.70,"utility":0.80}]'::jsonb,
      %L::jsonb, '[]'::jsonb, now() + interval '1 day', '{}'::jsonb, 1, '[]'::jsonb)$$,
    (select run_id from atomic_runs where name = 'invalid'),
    (select jsonb_agg(jsonb_build_object('user_id',m.user_id,'outcome','no_candidate'))::text
     from halal_mode_private.matching_run_member_snapshots m
     where m.run_id = (select run_id from atomic_runs where name = 'invalid'))
  ),
  '40001',
  'Every chosen edge must be a bounded frozen candidate',
  'an edge that became eligible after snapshot preparation is rejected'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_rounds
    where run_id = (select run_id from atomic_runs where name = 'invalid')
  ) and not exists (
    select 1 from halal_mode_private.matching_member_run_outcomes
    where run_id = (select run_id from atomic_runs where name = 'invalid')
  ) and exists (
    select 1 from halal_mode_private.matching_runs
    where id = (select run_id from atomic_runs where name = 'invalid')
      and finished_at is null
  ),
  'an invalid live plan leaves no partial rounds, outcomes, or completion'
);

insert into blocks (blocker_id, blocked_id) values (
  '00000000-0000-0000-0000-000000005805',
  '00000000-0000-0000-0000-000000005806'
);
select throws_ok(
  format(
    $$select public.matching_live_finalize_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005806","score":0.70,"utility":0.80}]'::jsonb,
      %L::jsonb, '[]'::jsonb, now() + interval '1 day', '{}'::jsonb, 1, '[]'::jsonb)$$,
    (select run_id from atomic_runs where name = 'blocked'),
    (select jsonb_agg(jsonb_build_object(
      'user_id',m.user_id,
      'outcome',case when m.user_id in (
        '00000000-0000-0000-0000-000000005805'::uuid,
        '00000000-0000-0000-0000-000000005806'::uuid
      ) then 'served' else 'no_candidate' end
    ))::text
    from halal_mode_private.matching_run_member_snapshots m
    where m.run_id = (select run_id from atomic_runs where name = 'blocked'))
  ),
  '40001',
  'MATCHING_LATE_VETO: current safety state vetoes a frozen matching edge',
  'a late block vetoes live finalization even though the pair was snapshotted'
);
delete from blocks
where blocker_id = '00000000-0000-0000-0000-000000005805'
  and blocked_id = '00000000-0000-0000-0000-000000005806';

create temporary table shadow_before as select
  (select count(*) from rounds) as rounds,
  (select count(*) from introductions) as introductions,
  (select count(*) from connections) as connections,
  (select count(*) from halal_mode_private.pair_exposure) as pair_exposure,
  (select count(*) from halal_mode_private.matching_member_run_outcomes) as outcomes,
  (select count(*) from halal_mode_private.notification_devices) as notifications;

create temporary table shadow_result as
select public.matching_shadow_finalize_service(
  (select run_id from atomic_runs where name = 'shadow'),
  '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005806","score":0.70,"utility":0.80}]'::jsonb,
  '{"fetch":3}'::jsonb, 2048, '[]'::jsonb
) as result;

select ok(
  (select (result ->> 'idempotent')::boolean is false
          and (result ->> 'pairs_created')::integer = 1
          and (result ->> 'rounds_created')::integer = 2
   from shadow_result),
  'shadow finalization derives counts from stored shadow rows'
);
select is(
  (select count(*)::integer from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from atomic_runs where name = 'shadow')),
  2,
  'shadow finalization writes two directed evidence rows'
);
select ok(
  (select count(*) from rounds) = (select rounds from shadow_before)
  and (select count(*) from introductions) = (select introductions from shadow_before)
  and (select count(*) from connections) = (select connections from shadow_before)
  and (select count(*) from halal_mode_private.pair_exposure) = (select pair_exposure from shadow_before)
  and (select count(*) from halal_mode_private.matching_member_run_outcomes) = (select outcomes from shadow_before)
  and (select count(*) from halal_mode_private.notification_devices) = (select notifications from shadow_before),
  'shadow finalization mutates no live matching, exposure, outcome, or notification state'
);
select ok(
  (public.matching_shadow_finalize_service(
    (select run_id from atomic_runs where name = 'shadow'),
    '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005806","score":0.70,"utility":0.80}]'::jsonb,
    '{"fetch":3}'::jsonb, 2048, '[]'::jsonb
  ) ->> 'idempotent')::boolean,
  'an exact shadow retry returns the stored result idempotently'
);
select is(
  (select count(*)::integer from halal_mode_private.shadow_round_edges
   where run_id = (select run_id from atomic_runs where name = 'shadow')),
  2,
  'an exact shadow retry creates no duplicate evidence'
);
select throws_ok(
  format(
    $$select public.matching_shadow_finalize_service(%L::uuid,
      '[{"a":"00000000-0000-0000-0000-000000005805","b":"00000000-0000-0000-0000-000000005806","score":0.70,"utility":0.80}]'::jsonb,
      '{"fetch":4}'::jsonb, 2048, '[]'::jsonb)$$,
    (select run_id from atomic_runs where name = 'shadow')
  ),
  '40001',
  'A finished shadow run cannot be finalized with a different request',
  'a conflicting shadow retry cannot rewrite evidence or metrics'
);
select throws_ok(
  format(
    $$select public.matching_run_finish(%L::uuid, null, null, null, null,
      '{}'::jsonb, 1, '[]'::jsonb, 'overwrite')$$,
    (select run_id from atomic_runs where name = 'shadow')
  ),
  '40001',
  'A successful or finished run cannot be overwritten',
  'the failure recorder cannot overwrite successful shadow truth'
);

select lives_ok(
  format(
    $$select public.matching_run_finish(%L::uuid, null, null, null, null,
      '{"fetch":9}'::jsonb, 1024, '["candidate_fetch_failed"]'::jsonb,
      'candidate fetch failed')$$,
    (select run_id from atomic_runs where name = 'failed')
  ),
  'an unfinished run can record a genuine failure with derived counts'
);
select ok(
  exists (
    select 1 from halal_mode_private.matching_runs
    where id = (select run_id from atomic_runs where name = 'failed')
      and finished_at is not null and error = 'candidate fetch failed'
      and pairs_created = 0 and rounds_created = 0
      and eligible_members = 6 and edges_after_filter = 9
  ),
  'failure completion derives counts instead of trusting the caller'
);
select throws_ok(
  format(
    $$select public.matching_run_finish(%L::uuid, 999, null, null, null,
      '{}'::jsonb, 1, '[]'::jsonb, 'failed')$$,
    (select run_id from atomic_runs where name = 'contradict')
  ),
  '22023',
  'Caller metrics contradict stored run truth',
  'a caller cannot record contradictory failure counts'
);
select ok(
  position('introductions' in pg_get_functiondef(
    'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)'::regprocedure
  )) = 0
  and position('connections' in pg_get_functiondef(
    'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)'::regprocedure
  )) = 0
  and position('pair_exposure' in pg_get_functiondef(
    'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)'::regprocedure
  )) = 0
  and position('notification' in pg_get_functiondef(
    'public.matching_shadow_finalize_service(uuid,jsonb,jsonb,bigint,jsonb)'::regprocedure
  )) = 0,
  'the public shadow finalizer has no live write target'
);
select ok(
  not has_function_privilege('service_role',
    'halal_mode_private.matching_finalize_hash(text,jsonb,jsonb,jsonb,timestamptz,jsonb,bigint,jsonb)',
    'EXECUTE')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_runs', 'SELECT'),
  'canonical hashes, results, and matching runs remain private'
);

select * from finish();
rollback;
