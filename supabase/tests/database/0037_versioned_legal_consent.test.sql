begin;

set local search_path = public, extensions, halal_mode_private;
select plan(4);

select ok(
  has_function_privilege('authenticated', 'public.complete_onboarding(text,text,date,text,text,text,text,text)', 'EXECUTE'),
  'members can complete onboarding through the consent-aware RPC'
);

select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.member_legal_consents', 'SELECT'),
  'the private consent ledger is not readable by members'
);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000371', 'consent@example.test');

do $$ begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000371","role":"authenticated"}',
    true
  );
end $$;

select throws_ok(
  $$ select complete_onboarding('Consent Member', 'Consent', '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', 'old', '2026-07-29') $$,
  '22023',
  'Current legal documents must be accepted',
  'stale document versions are rejected server-side'
);

select lives_ok(
  $$ select complete_onboarding('Consent Member', 'Consent', '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', '2026-07-29', '2026-07-29') $$,
  'current document versions create the member profile and consent record'
);

select * from finish();
rollback;
