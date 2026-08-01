begin;

set local search_path = public, extensions;
select plan(5);

-- `explicit_pass` is deliberately a fourth selection outcome, not a rename of
-- `released`.  The database can enforce that the values remain distinct; the
-- product meaning attached to each value must be exercised separately when
-- the submission RPC starts accepting the new outcome.
select is(
  enum_range(null::selection_decision)::text[],
  array['kept', 'released', 'expired', 'explicit_pass']::text[],
  'selection decisions retain the three legacy outcomes and add explicit_pass'
);

select isnt(
  'explicit_pass'::selection_decision,
  'released'::selection_decision,
  'a deliberate pass is distinct from a round-specific release'
);

select is(
  'explicit_pass'::selection_decision::text,
  'explicit_pass',
  'explicit_pass can be stored as a selection decision'
);

select ok(
  not ('blocked' = any(enum_range(null::selection_decision)::text[])),
  'blocking is not duplicated as a selection outcome'
);

select ok(
  not ('reported' = any(enum_range(null::selection_decision)::text[])),
  'reporting is not duplicated as a selection outcome'
);

select * from finish();
rollback;
