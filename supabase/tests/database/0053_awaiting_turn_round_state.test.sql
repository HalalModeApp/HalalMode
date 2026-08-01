begin;
set local search_path = public, extensions;
select plan(14);

select ok(
  to_regprocedure('public.get_daily_round_state()') is null,
  'the broken parallel round-state RPC does not exist'
);
select ok(
  has_function_privilege('authenticated', 'public.get_current_round_state()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_current_round_state()', 'EXECUTE'),
  'the established round-state RPC remains authenticated only'
);
select ok(
  not has_table_privilege('anon', 'halal_mode_private.matching_member_run_outcomes', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.matching_member_run_outcomes', 'SELECT'),
  'queue outcomes cannot be inspected by clients'
);
select ok(
  position('get_current_round()' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0
  and position('member_has_current_legal_consents' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) > 0,
  'ready cards and legal consent retain their reviewed sources'
);
select ok(
  position('passes_criteria' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) = 0
  and position('selection_scores' in pg_get_functiondef('public.get_current_round_state()'::regprocedure)) = 0,
  'empty-state explanations do not inspect candidates or private scores'
);

select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select public.get_current_round_state()$$,
  '42501',
  'You must be signed in',
  'an unauthenticated caller is rejected inside the function'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005301', 'state-member@example.test'),
  ('00000000-0000-0000-0000-000000005302', 'state-subject@example.test'),
  ('00000000-0000-0000-0000-000000005303', 'state-cap@example.test'),
  ('00000000-0000-0000-0000-000000005311', 'state-cap-1@example.test'),
  ('00000000-0000-0000-0000-000000005312', 'state-cap-2@example.test'),
  ('00000000-0000-0000-0000-000000005313', 'state-cap-3@example.test'),
  ('00000000-0000-0000-0000-000000005314', 'state-cap-4@example.test'),
  ('00000000-0000-0000-0000-000000005315', 'state-cap-5@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000005301', 'State Member', 'State', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['state.jpg'], true),
  ('00000000-0000-0000-0000-000000005302', 'Safe Subject', 'Safe', '1991-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('b', 50), array['subject.jpg'], true),
  ('00000000-0000-0000-0000-000000005303', 'Capacity Member', 'Capacity', '1989-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('c', 50), array['capacity.jpg'], true),
  ('00000000-0000-0000-0000-000000005311', 'Cap One', 'One', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005312', 'Cap Two', 'Two', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005313', 'Cap Three', 'Three', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005314', 'Cap Four', 'Four', '1990-01-01', 'female', '', '', null, null, '', '{}', false),
  ('00000000-0000-0000-0000-000000005315', 'Cap Five', 'Five', '1990-01-01', 'female', '', '', null, null, '', '{}', false);

insert into private_preferences (user_id, matching_preferences_completed_at) values
  ('00000000-0000-0000-0000-000000005301', now()),
  ('00000000-0000-0000-0000-000000005303', now());
insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (values
  ('00000000-0000-0000-0000-000000005301'::uuid),
  ('00000000-0000-0000-0000-000000005303'::uuid)
) member(id)
cross join halal_mode_private.legal_document_registry document
where document.is_current;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000005301","role":"authenticated"}', true);
select is(
  public.get_current_round_state() ->> 'status',
  'no_suitable_introductions',
  'no live outcome is not mislabelled as deferred'
);

insert into halal_mode_private.matching_runs (
  id, algorithm_version, config_version, seed, mode, started_at
) values
  ('00000000-0000-0000-0000-000000005321', 'test', 1, 1, 'live', now()),
  ('00000000-0000-0000-0000-000000005322', 'test', 1, 2, 'shadow', now() + interval '1 second');
insert into halal_mode_private.matching_member_run_outcomes (
  run_id, user_id, outcome, valid_until
) values (
  '00000000-0000-0000-0000-000000005321',
  '00000000-0000-0000-0000-000000005301',
  'deferred', now() + interval '1 day'
);
select is(
  public.get_current_round_state() ->> 'status',
  'awaiting_turn',
  'a current durable live deferred outcome returns awaiting_turn'
);
update halal_mode_private.matching_member_run_outcomes
set outcome = 'no_candidate'
where run_id = '00000000-0000-0000-0000-000000005321'
  and user_id = '00000000-0000-0000-0000-000000005301';
select is(
  public.get_current_round_state() ->> 'status',
  'no_suitable_introductions',
  'a no-candidate outcome keeps the established empty state'
);
update halal_mode_private.matching_member_run_outcomes
set outcome = 'deferred', valid_until = now() - interval '1 second'
where run_id = '00000000-0000-0000-0000-000000005321'
  and user_id = '00000000-0000-0000-0000-000000005301';
select is(
  public.get_current_round_state() ->> 'status',
  'no_suitable_introductions',
  'an expired deferred outcome cannot claim the member is still queued'
);
delete from halal_mode_private.matching_member_run_outcomes
where run_id = '00000000-0000-0000-0000-000000005321';
insert into halal_mode_private.matching_member_run_outcomes (
  run_id, user_id, outcome, valid_until
) values (
  '00000000-0000-0000-0000-000000005322',
  '00000000-0000-0000-0000-000000005301',
  'deferred', now() + interval '1 day'
);
select is(
  public.get_current_round_state() ->> 'status',
  'no_suitable_introductions',
  'a shadow-only outcome cannot affect member-facing state'
);

insert into connections (user_a, user_b) values
  ('00000000-0000-0000-0000-000000005303', '00000000-0000-0000-0000-000000005311'),
  ('00000000-0000-0000-0000-000000005303', '00000000-0000-0000-0000-000000005312'),
  ('00000000-0000-0000-0000-000000005303', '00000000-0000-0000-0000-000000005313'),
  ('00000000-0000-0000-0000-000000005303', '00000000-0000-0000-0000-000000005314'),
  ('00000000-0000-0000-0000-000000005303', '00000000-0000-0000-0000-000000005315');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000005303","role":"authenticated"}', true);
select is(
  public.get_current_round_state() ->> 'status',
  'at_match_capacity',
  'a ready member exactly at connection capacity receives the capacity state'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000005301","role":"authenticated"}', true);
insert into rounds (id, user_id, tier, expires_at)
values ('00000000-0000-0000-0000-000000005331', '00000000-0000-0000-0000-000000005301', 'free', now() + interval '1 day');
insert into introductions (id, round_id, viewer_id, subject_id, agreements)
values ('00000000-0000-0000-0000-000000005332', '00000000-0000-0000-0000-000000005331', '00000000-0000-0000-0000-000000005301', '00000000-0000-0000-0000-000000005302', '[]');
select is(
  public.get_current_round_state() ->> 'status',
  'ready',
  'an existing nonempty round wins over all empty-state diagnostics'
);
select ok(
  jsonb_typeof(public.get_current_round_state() -> 'round') = 'object'
  and jsonb_array_length(public.get_current_round_state() #> '{round,introductions}') = 1
  and not ((public.get_current_round_state() #> '{round,introductions,0,profile}') ? 'latitude')
  and not ((public.get_current_round_state() #> '{round,introductions,0,profile}') ? 'birthDate'),
  'ready returns the full privacy-safe round object rather than an id or private fields'
);

select * from finish();
rollback;
