begin;
set local search_path = public, extensions, halal_mode_private;
select plan(13);

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.legal_document_registry', 'SELECT')
  and not has_table_privilege('authenticated', 'halal_mode_private.member_legal_consent_history', 'SELECT'),
  'registry and consent history remain private'
);
select is(
  (select count(*)::int from halal_mode_private.legal_document_registry where is_current),
  2,
  'exactly Terms and Privacy are current'
);
select ok(
  to_regclass('halal_mode_private.member_legal_consents') is null,
  'the mutable one-row consent ledger was removed after migration'
);
select ok(
  has_function_privilege('authenticated', 'public.get_my_legal_consent_status()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.accept_current_legal_documents()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.accept_current_legal_documents()', 'EXECUTE'),
  'only authenticated members can use reviewed consent RPCs'
);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000461', 'current-consent@example.test');
insert into profiles (id, name, first_name, birth_date, gender, city, country, latitude, longitude, onboarding_complete)
values ('00000000-0000-0000-0000-000000000461', 'Registry Member', 'Registry', '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000461","role":"authenticated"}', true);

select is(
  (public.get_my_legal_consent_status()->>'required')::boolean,
  true,
  'an enrolled member without history is gated'
);
select is(
  public.get_current_round_state()->>'status',
  'legal_consent_required',
  'daily introductions fail closed while consent is missing'
);
select lives_ok(
  $$ select public.accept_current_legal_documents() $$,
  'accepting current registry documents succeeds'
);
select is(
  (select count(*)::int from halal_mode_private.member_legal_consent_history where user_id = '00000000-0000-0000-0000-000000000461'),
  2,
  'Terms and Privacy acceptances are separate history rows'
);
select lives_ok(
  $$ select public.accept_current_legal_documents() $$,
  'accepting the same versions again is idempotent'
);
select is(
  (select count(*)::int from halal_mode_private.member_legal_consent_history where user_id = '00000000-0000-0000-0000-000000000461'),
  2,
  'idempotent acceptance does not overwrite or duplicate history'
);

update halal_mode_private.legal_document_registry set is_current = false where document_type = 'terms';
insert into halal_mode_private.legal_document_registry
  (document_type, version, title, effective_date, url, is_current)
values ('terms', '2026-08-01', 'Terms of Service', '2026-08-01', 'https://halalmo.de/terms', true);

select is(
  (public.get_my_legal_consent_status()->>'required')::boolean,
  true,
  'publishing a new current version requires fresh acceptance'
);
select is(
  public.get_current_round_state()->>'status',
  'legal_consent_required',
  'a stale acceptance remains gated from daily introductions'
);
select ok(
  position('member_has_current_legal_consents(p.id)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0,
  'stale members do not occupy reciprocal introduction slots'
);

select * from finish();
rollback;
