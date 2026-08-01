begin;

set local search_path = public, extensions;
select plan(14);

-- match_health must remain a derived, server-only view.  Turning it into a
-- table would create a second source of truth for rounds, connections, and
-- selection history.
select is(
  (select c.relkind::text
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'halal_mode_private' and c.relname = 'match_health'),
  'v',
  'match_health remains a view'
);

select ok(
  not exists (
    select 1
    from information_schema.table_privileges
    where table_schema = 'halal_mode_private'
      and table_name = 'match_health'
      and grantee = 'PUBLIC'
      and privilege_type = 'SELECT'
  )
  and not has_table_privilege('anon', 'halal_mode_private.match_health', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.match_health', 'SELECT'),
  'no client role can read private matching health signals'
);

select ok(
  not has_table_privilege('anon', 'halal_mode_private.matching_member_run_outcomes', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_member_run_outcomes', 'SELECT'),
  'durable live-run outcomes remain server-only'
);

select ok(
  has_column('halal_mode_private', 'match_health', 'rounds_since_last_served')
  and has_column('halal_mode_private', 'match_health', 'last_served_at'),
  'the rotation queue inputs are exposed inside the private view'
);

-- The complete initial config includes rotation, so there is no second active
-- version that could make the recorded behavior ambiguous.
select is(
  (select count(*)::integer
   from halal_mode_private.matching_config
   where activated_at is not null),
  1,
  'exactly one matching configuration is active'
);

select is(
  halal_mode_private.active_matching_config_version(),
  1,
  'the complete initial configuration remains the sole active version'
);

select is(
  (halal_mode_private.active_matching_config() ->> 'rotation_enabled')::boolean,
  true,
  'serving rotation is enabled in the active configuration'
);

select is(
  (halal_mode_private.active_matching_config() ->> 'rotation_min_set_size')::integer,
  3,
  'rotation keeps sets at the documented minimum of three'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005101', 'waiting-member@example.test'),
  ('00000000-0000-0000-0000-000000005102', 'subject-member@example.test'),
  ('00000000-0000-0000-0000-000000005103', 'recently-served@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005101', 'Waiting Member', 'Waiting', '1990-01-01', 'male', true),
  ('00000000-0000-0000-0000-000000005102', 'Subject Member', 'Subject', '1991-01-01', 'female', true),
  ('00000000-0000-0000-0000-000000005103', 'Recently Served', 'Recent', '1992-01-01', 'male', true);

insert into selection_scores (user_id, score, times_shown, times_kept) values
  ('00000000-0000-0000-0000-000000005101', 0.5000, 15, 3),
  ('00000000-0000-0000-0000-000000005103', 0.5000, 3, 1);

insert into halal_mode_private.matching_runs (
  id, algorithm_version, config_version, seed, mode, started_at, finished_at
) values
  ('00000000-0000-0000-0000-000000005111', 'test', 1, 1, 'live', '2026-01-01 00:00:00+00', '2026-01-01 00:01:00+00'),
  ('00000000-0000-0000-0000-000000005112', 'test', 1, 2, 'live', '2026-01-03 00:00:00+00', '2026-01-03 00:01:00+00'),
  ('00000000-0000-0000-0000-000000005113', 'test', 1, 3, 'live', '2026-01-05 00:00:00+00', '2026-01-05 00:01:00+00'),
  ('00000000-0000-0000-0000-000000005114', 'test', 1, 4, 'shadow', '2026-01-06 00:00:00+00', '2026-01-06 00:01:00+00');

insert into halal_mode_private.matching_member_run_outcomes (
  run_id, user_id, outcome, valid_until
) values
  ('00000000-0000-0000-0000-000000005111', '00000000-0000-0000-0000-000000005101', 'served', '2027-01-01 00:00:00+00'),
  ('00000000-0000-0000-0000-000000005112', '00000000-0000-0000-0000-000000005101', 'deferred', '2027-01-01 00:00:00+00'),
  ('00000000-0000-0000-0000-000000005113', '00000000-0000-0000-0000-000000005101', 'no_candidate', '2027-01-01 00:00:00+00'),
  ('00000000-0000-0000-0000-000000005111', '00000000-0000-0000-0000-000000005103', 'deferred', '2027-01-01 00:00:00+00'),
  ('00000000-0000-0000-0000-000000005113', '00000000-0000-0000-0000-000000005103', 'served', '2027-01-01 00:00:00+00'),
  -- Even direct private test data from a shadow run must not age the view.
  ('00000000-0000-0000-0000-000000005114', '00000000-0000-0000-0000-000000005103', 'deferred', '2027-01-01 00:00:00+00');

select is(
  (select rounds_since_last_served::integer
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005101'),
  2,
  'live deferred and no-candidate runs after service contribute to waiting time'
);

select is(
  (select last_served_at
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005101'),
  '2026-01-01 00:00:00+00'::timestamptz,
  'last_served_at comes from the latest durable live served outcome'
);

select is(
  (select rounds_since_last_served::integer
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005103'),
  0,
  'a member served in the most recent round has no waiting rounds'
);

select is(
  (select qualified_exposures
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005101'),
  15,
  'qualified exposure remains derived from the private selection score row'
);

select is(
  (select model_confidence
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005101'),
  1.0::numeric,
  'model confidence is capped at one at the configured exposure threshold'
);

select is(
  (select model_confidence
   from halal_mode_private.match_health
   where user_id = '00000000-0000-0000-0000-000000005103'),
  0.2::numeric,
  'model confidence scales below the configured exposure threshold'
);

select * from finish();
rollback;
