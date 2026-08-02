begin;

set local search_path = public, extensions;
select plan(5);

select ok(
  has_function_privilege('service_role', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.expire_stale_rounds()', 'EXECUTE'),
  'the Fajr service role can execute both internal round routines'
);
select ok(
  not has_function_privilege('authenticated', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.expire_stale_rounds()', 'EXECUTE'),
  'members cannot invoke the internal round routines'
);
-- Whitespace-normalised, because this asserts that the guard exists rather than
-- how it is wrapped. It broke once on a reformat that changed no behaviour at
-- all, which is a test failing for the wrong reason.
select ok(
  position(
    'vp.longitude is null or s.latitude is null or s.longitude is null'
    in regexp_replace(
      pg_get_functiondef('public.passes_criteria(uuid,uuid)'::regprocedure),
      '\s+', ' ', 'g'
    )
  ) > 0,
  'same-country matching fails closed when any coordinate is missing'
);
select ok(
  position('accepts_subject_country' in pg_get_functiondef('public.passes_criteria(uuid,uuid)'::regprocedure)) > 0,
  'reciprocal international matching remains an explicit gate'
);
select ok(
  position('lower(trim(vp.country)) = lower(trim(s.country))' in pg_get_functiondef('public.passes_criteria(uuid,uuid)'::regprocedure)) > 0,
  'the coordinate rule is scoped to same-country matching only'
);

select * from finish();
rollback;
