begin;
set local search_path = public, extensions;
select plan(8);

select ok(
  not has_function_privilege('authenticated', 'public.profile_is_ready_for_matching(uuid)', 'EXECUTE'),
  'members cannot invoke the matching-readiness helper directly'
);
select ok(
  has_function_privilege('service_role', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE'),
  'the service scheduler retains authority to generate rounds'
);
select ok(
  position('length(trim(bio)) >= 40' in pg_get_functiondef('public.profile_is_ready_for_matching(uuid)'::regprocedure)) > 0
    and position('cardinality(photos) >= 1' in pg_get_functiondef('public.profile_is_ready_for_matching(uuid)'::regprocedure)) > 0,
  'readiness requires a substantive bio and photo'
);
select ok(
  position('matching_preferences_completed_at is not null' in pg_get_functiondef('public.profile_is_ready_for_matching(uuid)'::regprocedure)) > 0,
  'readiness requires intentionally saved matching preferences'
);
select ok(
  position('profile_is_ready_for_matching(p.id)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0,
  'the real generator gates round creation on profile readiness'
);
select ok(
  (select count(*) from regexp_matches(pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure), E'profile_is_ready_for_matching\\(p.id\\)', 'g')) = 2,
  'the generator gates both round creation and candidate eligibility'
);
select ok(
  position('passes_criteria(m.id, f.id)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0,
  'readiness supplements rather than replaces reciprocal criteria'
);
select ok(
  position('not profile_is_ready_for_matching(auth.uid())' in pg_get_functiondef('public.get_current_round()'::regprocedure)) > 0,
  'an older, existing round is not exposed to an incomplete profile'
);

select * from finish();
rollback;
