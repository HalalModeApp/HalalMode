begin;
set local search_path = public, extensions;
select plan(7);

select ok(
  has_function_privilege('authenticated', 'public.get_current_round_state()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_current_round_state()', 'EXECUTE'),
  'only signed-in members can request their daily round state'
);
select ok(
  position('profile_not_ready' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0
  and position('no_suitable_introductions' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0
  and position('matching_inputs_unavailable' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0,
  'the RPC exposes only the documented coarse empty reasons'
);
select ok(
  position('v_member_id uuid := auth.uid()' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0,
  'the explanation is scoped to the signed-in member'
);
select ok(
  position('get_current_round()' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0,
  'the existing reviewed round response remains the source of cards'
);
select ok(
  position('jsonb_array_length' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0
  and position("'ready'" in pg_get_functiondef('public.get_current_round_state()'::regprocedure))
    < position('select * into v_profile' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)),
  'an existing non-empty round is returned before input diagnostics'
);
select ok(
  position('v_profile.latitude is null' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0
  and position('matching_preferences_completed_at is null' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0,
  'matching evaluation failure depends only on the member own required inputs'
);
select ok(
  position('passes_criteria' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) = 0
  and position('selection_scores' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) = 0
  and position('count(' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) = 0,
  'the explanation does not inspect candidates, scores, or popularity counts'
);

select * from finish();
rollback;
