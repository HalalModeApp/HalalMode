begin;

set local search_path = public, extensions, halal_mode_private;
select plan(20);

select ok(
  has_function_privilege(
    'authenticated', 'public.report_introduction_member(uuid,text)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.block_introduction_member(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.report_introduction_member(uuid,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.block_introduction_member(uuid)', 'EXECUTE'
  ),
  'introduction safety RPCs are authenticated-only'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'halal_mode_private.current_introduction_subject(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'halal_mode_private.current_introduction_subject(uuid)',
    'EXECUTE'
  ),
  'the introduction subject resolver is private'
);

select ok(
  has_function_privilege(
    'authenticated',
    'halal_mode_private.can_read_current_introduction(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'halal_mode_private.can_read_current_introduction(uuid)',
    'EXECUTE'
  )
  and position('b.blocker_id = auth.uid()' in pg_get_functiondef(
    'halal_mode_private.can_read_current_introduction(uuid)'::regprocedure
  )) > 0
  and position('b.blocked_id = auth.uid()' in pg_get_functiondef(
    'halal_mode_private.can_read_current_introduction(uuid)'::regprocedure
  )) > 0,
  'the reviewed RLS helper hides blocks in either direction without returning ids'
);

select ok(
  position('i.viewer_id = auth.uid()' in pg_get_functiondef(
    'halal_mode_private.current_introduction_subject(uuid)'::regprocedure
  )) > 0
  and position('r.user_id = auth.uid()' in pg_get_functiondef(
    'halal_mode_private.current_introduction_subject(uuid)'::regprocedure
  )) > 0
  and position('r.submitted_at is null' in pg_get_functiondef(
    'halal_mode_private.current_introduction_subject(uuid)'::regprocedure
  )) > 0
  and position('r.expires_at > now()' in pg_get_functiondef(
    'halal_mode_private.current_introduction_subject(uuid)'::regprocedure
  )) > 0,
  'the resolver requires a current viewer-owned introduction and round'
);

select ok(
  position('current_introduction_subject(p_introduction_id)' in pg_get_functiondef(
    'public.report_introduction_member(uuid,text)'::regprocedure
  )) > 0
  and position('current_introduction_subject(p_introduction_id)' in pg_get_functiondef(
    'public.block_introduction_member(uuid)'::regprocedure
  )) > 0,
  'both RPCs derive the subject from the introduction id'
);

select ok(
  position('require_current_legal_consents(v_viewer)' in pg_get_functiondef(
    'public.report_introduction_member(uuid,text)'::regprocedure
  )) > 0
  and position('require_current_legal_consents(v_viewer)' in pg_get_functiondef(
    'public.block_introduction_member(uuid)'::regprocedure
  )) > 0,
  'both RPCs preserve the current legal-consent boundary'
);

select ok(
  position('blocks b' in pg_get_functiondef(
    'public.get_current_round()'::regprocedure
  )) > 0
  and position('b.blocker_id = auth.uid()' in pg_get_functiondef(
    'public.get_current_round()'::regprocedure
  )) > 0,
  'the SECURITY DEFINER round read hides blocked pairs explicitly'
);

select ok(
  position('can_read_current_introduction' in (
    select qual
    from pg_policies
    where schemaname = 'public'
      and tablename = 'introductions'
      and policyname = 'own introductions'
  )) > 0,
  'direct introduction reads also hide blocked pairs through RLS'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000481', 'intro-safety-a@example.test'),
  ('00000000-0000-0000-0000-000000000482', 'intro-safety-b@example.test'),
  ('00000000-0000-0000-0000-000000000483', 'intro-safety-c@example.test');

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, bio, photos,
  onboarding_complete
) values
  (
    '00000000-0000-0000-0000-000000000481', 'Intro Safety A', 'A',
    '1990-01-01', 'female', 'Madinah', 'Saudi Arabia',
    'A complete profile used to verify introduction safety boundaries.',
    array['00000000-0000-0000-0000-000000000481/photo.jpg'], true
  ),
  (
    '00000000-0000-0000-0000-000000000482', 'Intro Safety B', 'B',
    '1990-01-01', 'male', 'Madinah', 'Saudi Arabia',
    'A complete profile used to verify reciprocal card hiding behavior.',
    array['00000000-0000-0000-0000-000000000482/photo.jpg'], true
  ),
  (
    '00000000-0000-0000-0000-000000000483', 'Intro Safety C', 'C',
    '1990-01-01', 'female', 'Madinah', 'Saudi Arabia',
    'A complete profile used to verify ownership rejection behavior.',
    array['00000000-0000-0000-0000-000000000483/photo.jpg'], true
  );

insert into private_preferences (user_id, matching_preferences_completed_at)
values
  ('00000000-0000-0000-0000-000000000481', now()),
  ('00000000-0000-0000-0000-000000000482', now()),
  ('00000000-0000-0000-0000-000000000483', now());

insert into halal_mode_private.member_legal_consent_history
  (user_id, document_type, version, acceptance_context)
select p.id, d.document_type, d.version, 'reacceptance'
from profiles p
cross join halal_mode_private.legal_document_registry d
where p.id in (
  '00000000-0000-0000-0000-000000000481',
  '00000000-0000-0000-0000-000000000482',
  '00000000-0000-0000-0000-000000000483'
) and d.is_current;

insert into rounds (id, user_id, tier, expires_at) values
  (
    '00000000-0000-0000-0000-000000004811',
    '00000000-0000-0000-0000-000000000481', 'free', now() + interval '1 day'
  ),
  (
    '00000000-0000-0000-0000-000000004812',
    '00000000-0000-0000-0000-000000000482', 'free', now() + interval '1 day'
  ),
  (
    '00000000-0000-0000-0000-000000004813',
    '00000000-0000-0000-0000-000000000483', 'free', now() + interval '1 day'
  );

insert into introductions (
  id, round_id, viewer_id, subject_id, reciprocal_id
) values
  (
    '00000000-0000-0000-0000-000000004821',
    '00000000-0000-0000-0000-000000004811',
    '00000000-0000-0000-0000-000000000481',
    '00000000-0000-0000-0000-000000000482', null
  ),
  (
    '00000000-0000-0000-0000-000000004822',
    '00000000-0000-0000-0000-000000004812',
    '00000000-0000-0000-0000-000000000482',
    '00000000-0000-0000-0000-000000000481',
    '00000000-0000-0000-0000-000000004821'
  ),
  (
    '00000000-0000-0000-0000-000000004823',
    '00000000-0000-0000-0000-000000004813',
    '00000000-0000-0000-0000-000000000483',
    '00000000-0000-0000-0000-000000000482', null
  );
update introductions
set reciprocal_id = '00000000-0000-0000-0000-000000004822'
where id = '00000000-0000-0000-0000-000000004821';

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000481","role":"authenticated"}',
  true
);

select lives_ok(
  $$ select report_introduction_member(
    '00000000-0000-0000-0000-000000004821', 'harassment'
  ) $$,
  'a viewer can report the member in their current introduction'
);

select is(
  (
    select subject_id::text
    from reports
    where reporter_id = '00000000-0000-0000-0000-000000000481'
  ),
  '00000000-0000-0000-0000-000000000482',
  'the report subject is derived on the server'
);

select throws_ok(
  $$ select report_introduction_member(
    '00000000-0000-0000-0000-000000004821', 'not_an_allowed_reason'
  ) $$,
  '22023',
  'Report reason is invalid',
  'report reasons keep the existing allowlist validation'
);

select throws_ok(
  $$ select report_introduction_member(
    '00000000-0000-0000-0000-000000004821', null
  ) $$,
  '22023',
  'Report reason is invalid',
  'a null report reason is rejected by the allowlist'
);

select throws_ok(
  $$ select report_introduction_member(
    '00000000-0000-0000-0000-000000004823', 'other'
  ) $$,
  '42501',
  'Introduction is not available',
  'a viewer cannot report through another member''s introduction'
);

select throws_ok(
  $$ select block_introduction_member(
    '00000000-0000-0000-0000-000000004899'
  ) $$,
  '42501',
  'Introduction is not available',
  'a nonexistent introduction cannot be used to block a member'
);

select throws_ok(
  $$ select block_introduction_member(
    '00000000-0000-0000-0000-000000004823'
  ) $$,
  '42501',
  'Introduction is not available',
  'a viewer cannot block through another member''s introduction'
);

select lives_ok(
  $$ select block_introduction_member(
    '00000000-0000-0000-0000-000000004821'
  ) $$,
  'a viewer can block the member in their current introduction'
);

select is(
  (
    select blocked_id::text
    from blocks
    where blocker_id = '00000000-0000-0000-0000-000000000481'
  ),
  '00000000-0000-0000-0000-000000000482',
  'the block subject is derived on the server'
);

select is(
  jsonb_array_length(get_current_round()->'introductions'),
  0,
  'the blocked member disappears from the blocker''s current round'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000482","role":"authenticated"}',
  true
);
select is(
  jsonb_array_length(get_current_round()->'introductions'),
  0,
  'the blocker disappears from the blocked member''s reciprocal current round'
);

select is(
  (
    select count(*)::int
    from introductions
    where id in (
      '00000000-0000-0000-0000-000000004821',
      '00000000-0000-0000-0000-000000004822'
    )
  ),
  2,
  'blocking preserves both private introduction rows as audit history'
);

select * from finish();
rollback;
