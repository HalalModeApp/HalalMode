begin;

set local search_path = public, extensions;
select plan(8);

select ok(
  not has_function_privilege('authenticated', 'public.build_connection_compatibility_breakdown(uuid)', 'EXECUTE'),
  'members cannot call the compatibility helper directly'
);
select ok(
  position('compatibilityBreakdown' in pg_get_functiondef('halal_mode_private.get_connection_after_legal_consent(uuid)'::regprocedure)) > 0,
  'the authorised connection response includes the compatibility contract'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000221', 'compat-a@example.test'),
  ('00000000-0000-0000-0000-000000000222', 'compat-b@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, country, relocation,
  religious_practice, timeline, family_goals, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000000221', 'Compatibility A', 'A', '1990-01-01', 'male', 'Lebanon', 'open', 'practicing', 'within_1_year', 'open_to_children', true),
  ('00000000-0000-0000-0000-000000000222', 'Compatibility B', 'B', '1991-01-01', 'female', 'Peru', 'open', 'practicing', 'within_1_year', 'open_to_children', true);
insert into halal_mode_private.member_legal_consent_history
  (user_id, document_type, version, acceptance_context)
select p.id, d.document_type, d.version, 'reacceptance'
from profiles p
cross join halal_mode_private.legal_document_registry d
where p.id in (
  '00000000-0000-0000-0000-000000000221',
  '00000000-0000-0000-0000-000000000222'
) and d.is_current;
insert into connections (id, user_a, user_b, stage, recap) values
  ('00000000-0000-0000-0000-000000002201', '00000000-0000-0000-0000-000000000221', '00000000-0000-0000-0000-000000000222', 'recap',
   '[{"questionId":"q1","verdict":"aligned"}]'::jsonb);

select is(
  build_connection_compatibility_breakdown('00000000-0000-0000-0000-000000002201'),
  '[{"topic":"values","verdict":"aligned"},{"topic":"marriage_timing","verdict":"aligned"},{"topic":"location_and_relocation","verdict":"aligned"},{"topic":"family_plans","verdict":"aligned"},{"topic":"conversation","verdict":"aligned"}]'::jsonb,
  'recap breakdown uses only broad, neutral signals'
);
update connections set recap = '[{"questionId":"q1","verdict":"discuss"}]'::jsonb
where id = '00000000-0000-0000-0000-000000002201';
select is(
  build_connection_compatibility_breakdown('00000000-0000-0000-0000-000000002201')->4->>'verdict',
  'discuss',
  'conversation signal follows the already-revealed recap only'
);
update connections set stage = 'answering'
where id = '00000000-0000-0000-0000-000000002201';
select is(
  build_connection_compatibility_breakdown('00000000-0000-0000-0000-000000002201'),
  '[]'::jsonb,
  'no compatibility signal is available before the icebreaker recap'
);
update connections set stage = 'recap'
where id = '00000000-0000-0000-0000-000000002201';

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000221","role":"authenticated"}', true);
end $$;
select is(
  (get_connection('00000000-0000-0000-0000-000000002201')->'compatibilityBreakdown')->0->>'topic',
  'values',
  'the authenticated member receives a topic, not a private explanation'
);
with connection_dto as (
  select get_connection('00000000-0000-0000-0000-000000002201'::uuid) as payload
)
select ok(
  position('score' in payload::text) = 0
  and position('preferred_countries' in payload::text) = 0,
  'the connection DTO does not disclose score or private country settings'
)
from connection_dto;
select ok(
  jsonb_array_length(get_connection('00000000-0000-0000-0000-000000002201')->'compatibilityBreakdown') = 5,
  'the client contract has a stable five-topic shape'
);

select * from finish();
rollback;
