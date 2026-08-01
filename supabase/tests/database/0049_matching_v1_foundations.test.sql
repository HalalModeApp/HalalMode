begin;

set local search_path = public, extensions;
select plan(13);

-- Privacy is the property that matters most here: none of the matching
-- internals may be reachable by any client role, directly or through a view.

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.matching_config', 'SELECT'),
  'members cannot read matching configuration'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.matching_runs', 'SELECT'),
  'members cannot read matching run history'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.pair_exposure', 'SELECT'),
  'members cannot learn that a pair was shown before'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.shadow_round_edges', 'SELECT'),
  'members cannot read shadow round output'
);
select ok(
  not has_table_privilege('anon', 'halal_mode_private.match_health', 'SELECT'),
  'private matching signals are not readable anonymously'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.match_health', 'SELECT'),
  'private matching signals are not readable by members'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.active_matching_config()', 'EXECUTE'),
  'members cannot read the active configuration through its accessor'
);

-- Exactly one activated configuration, and it carries the documented defaults.

select is(
  (select count(*)::int from halal_mode_private.matching_config where activated_at is not null),
  1,
  'a single configuration version is active'
);
select is(
  (halal_mode_private.active_matching_config() ->> 'reciprocal_combiner'),
  'geometric',
  'the geometric mean is the documented default combiner'
);
select is(
  (halal_mode_private.active_matching_config() ->> 'exposure_full_confidence')::int,
  15,
  'the cold-start threshold is configuration, not a constant'
);
select is(
  (halal_mode_private.active_matching_config() ->> 'imbalance_lambda')::numeric,
  0.00,
  'the imbalance penalty ships disabled'
);

select is(
  (halal_mode_private.active_matching_config() ->> 'exposure_target_multiplier')::numeric,
  1.0,
  'fair share defaults to a member''s own tier entitlement'
);

-- The pair key is stored in one canonical direction, so exposure is a property
-- of the pair rather than of whoever happened to be the viewer.
select throws_ok(
  $$insert into halal_mode_private.pair_exposure (user_low, user_high)
    values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001')$$,
  '23514',
  null,
  'a reversed pair key is rejected'
);

select * from finish();
rollback;
