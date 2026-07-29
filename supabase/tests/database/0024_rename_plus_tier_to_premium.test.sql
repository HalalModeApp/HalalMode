begin;

set local search_path = public, extensions;
select plan(7);

select is(
  enum_range(null::membership_tier)::text[],
  array['free', 'premium']::text[],
  'the live membership enum has only free and premium values'
);
select is(
  (select introductions from tier_limits('premium')), 10,
  'Premium members receive ten introductions'
);
select is(
  (select keeps from tier_limits('premium')), 3,
  'Premium members can keep three introductions'
);
select is(
  (select open_connections from tier_limits('premium')), 10,
  'Premium members can hold ten open connections'
);
select ok(
  position('''premium''' in pg_get_functiondef('public.tier_limits(membership_tier)'::regprocedure)) > 0
  and position('''plus''' in pg_get_functiondef('public.tier_limits(membership_tier)'::regprocedure)) = 0,
  'the current limits function no longer contains the retired tier label'
);
select ok(
  not has_function_privilege('authenticated', 'public.tier_limits(membership_tier)', 'EXECUTE'),
  'tier policy remains server-internal'
);
select lives_ok(
  $$ select generate_round_for_pairs(now() + interval '1 hour') $$,
  'the matcher accepts the renamed enum value'
);

select * from finish();
rollback;
