begin;
set local search_path = public, extensions, halal_mode_private;
select plan(4);

select ok(
  has_function_privilege('authenticated', 'public.complete_onboarding(text,text,date,text,text,text,double precision,double precision,text,text)', 'EXECUTE'),
  'members complete onboarding through the current consent-aware RPC'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.member_legal_consent_history', 'SELECT'),
  'the private consent history is not directly readable by members'
);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000371', 'consent@example.test');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000371","role":"authenticated"}', true);

select throws_ok(
  $$ select complete_onboarding('Consent Member', 'Consent', '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, 'old', '2026-07-29') $$,
  '22023',
  'Current legal documents must be accepted',
  'stale document versions are rejected against the registry'
);
select lives_ok(
  $$ select complete_onboarding('Consent Member', 'Consent', '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, '2026-07-29', '2026-07-29') $$,
  'current registry versions create the profile and immutable history'
);

select * from finish();
rollback;
