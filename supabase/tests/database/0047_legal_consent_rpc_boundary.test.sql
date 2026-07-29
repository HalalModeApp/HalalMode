begin;
set local search_path = public, extensions, halal_mode_private;
select plan(14);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'halal_mode_private.member_legal_consent_history'::regclass
      and tgname = 'member_legal_consent_history_append_only'
      and tgenabled = 'O'
      and not tgisinternal
  ),
  'consent history has an enabled append-only trigger'
);

select ok(
  position('Legal consent history is append-only' in pg_get_functiondef(
    'halal_mode_private.guard_legal_consent_history_append_only()'::regprocedure
  )) > 0
  and position('service_role' in pg_get_functiondef(
    'halal_mode_private.guard_legal_consent_history_append_only()'::regprocedure
  )) > 0
  and position('app.legal_consent_maintenance' in pg_get_functiondef(
    'halal_mode_private.guard_legal_consent_history_append_only()'::regprocedure
  )) > 0,
  'append-only enforcement has explicit service and database-maintenance paths'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'halal_mode_private.member_legal_consent_history',
    'SELECT, INSERT, UPDATE, DELETE'
  ),
  'consent history retains no direct authenticated table privileges'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'halal_mode_private.require_current_legal_consents(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'halal_mode_private.require_current_legal_consents(uuid)',
    'EXECUTE'
  ),
  'the consent requirement helper is private'
);

select is(
  (
    with intended(signature) as (values
      ('public.release_introduction(uuid)'),
      ('public.submit_round_selections(uuid,uuid[])'),
      ('public.get_connection(uuid)'),
      ('public.get_connections()'),
      ('public.get_connection_recap(uuid)'),
      ('public.open_connection(uuid)'),
      ('public.close_connection(uuid)'),
      ('public.submit_question_picks(uuid,text[])'),
      ('public.submit_answer(uuid,text,text)'),
      ('public.send_message(uuid,text,text)'),
      ('public.mark_connection_messages_read(uuid)'),
      ('public.get_connection_messages(uuid,timestamp with time zone,uuid,integer)'),
      ('public.report_connection_member(uuid,text)'),
      ('public.block_connection_member(uuid)'),
      ('public.get_my_blocked_members()'),
      ('public.unblock_my_member(uuid)')
    )
    select count(*)::int from intended
    where position(
      'halal_mode_private.require_current_legal_consents(auth.uid())'
      in pg_get_functiondef(signature::regprocedure)
    ) > 0
  ),
  16,
  'every intended member-facing RPC checks current legal consent first'
);

select is(
  (
    with intended(signature) as (values
      ('public.release_introduction(uuid)'),
      ('public.submit_round_selections(uuid,uuid[])'),
      ('public.get_connection(uuid)'),
      ('public.get_connections()'),
      ('public.get_connection_recap(uuid)'),
      ('public.open_connection(uuid)'),
      ('public.close_connection(uuid)'),
      ('public.submit_question_picks(uuid,text[])'),
      ('public.submit_answer(uuid,text,text)'),
      ('public.send_message(uuid,text,text)'),
      ('public.mark_connection_messages_read(uuid)'),
      ('public.get_connection_messages(uuid,timestamp with time zone,uuid,integer)'),
      ('public.report_connection_member(uuid,text)'),
      ('public.block_connection_member(uuid)'),
      ('public.get_my_blocked_members()'),
      ('public.unblock_my_member(uuid)')
    )
    select count(*)::int from intended
    where has_function_privilege('authenticated', signature, 'EXECUTE')
      and not has_function_privilege('anon', signature, 'EXECUTE')
      and to_regprocedure('public.send_message(uuid,text)') is null
  ),
  16,
  'all intended public RPCs are executable only by authenticated members'
);

select is(
  (
    with retained(signature) as (values
      ('halal_mode_private.release_introduction_after_legal_consent(uuid)'),
      ('halal_mode_private.submit_round_selections_after_legal_consent(uuid,uuid[])'),
      ('halal_mode_private.get_connection_after_legal_consent(uuid)'),
      ('halal_mode_private.get_connections_after_legal_consent()'),
      ('halal_mode_private.get_connection_recap_after_legal_consent(uuid)'),
      ('halal_mode_private.open_connection_after_legal_consent(uuid)'),
      ('halal_mode_private.close_connection_after_legal_consent(uuid)'),
      ('halal_mode_private.submit_question_picks_after_legal_consent(uuid,text[])'),
      ('halal_mode_private.submit_answer_after_legal_consent(uuid,text,text)'),
      ('halal_mode_private.send_message_after_legal_consent(uuid,text,text)'),
      ('halal_mode_private.mark_connection_messages_read_after_legal_consent(uuid)'),
      ('halal_mode_private.get_connection_messages_after_legal_consent(uuid,timestamp with time zone,uuid,integer)'),
      ('halal_mode_private.report_connection_member_after_legal_consent(uuid,text)'),
      ('halal_mode_private.block_connection_member_after_legal_consent(uuid)'),
      ('halal_mode_private.get_my_blocked_members_after_legal_consent()'),
      ('halal_mode_private.unblock_my_member_after_legal_consent(uuid)')
    )
    select count(*)::int from retained
    where not has_function_privilege('authenticated', signature, 'EXECUTE')
      and not has_function_privilege('anon', signature, 'EXECUTE')
  ),
  16,
  'retained implementations cannot bypass public consent wrappers'
);

select ok(
  has_function_privilege(
    'authenticated',
    'halal_mode_private.can_read_profile_media(text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'halal_mode_private.can_delete_profile_media(text,text)',
    'EXECUTE'
  ),
  'unrelated private media policy helpers keep their existing grants'
);

select ok(
  position('Current legal documents must be accepted' in pg_get_functiondef(
    'halal_mode_private.require_current_legal_consents(uuid)'::regprocedure
  )) > 0
  and position('42501' in pg_get_functiondef(
    'halal_mode_private.require_current_legal_consents(uuid)'::regprocedure
  )) > 0,
  'stale consent uses a stable authorization error contract'
);

select ok(
  position('require_current_legal_consents' in pg_get_functiondef(
    'public.get_my_legal_consent_status()'::regprocedure
  )) = 0
  and position('require_current_legal_consents' in pg_get_functiondef(
    'public.accept_current_legal_documents()'::regprocedure
  )) = 0
  and position('require_current_legal_consents' in pg_get_functiondef(
    'public.complete_onboarding(text,text,date,text,text,text,double precision,double precision,text,text)'::regprocedure
  )) = 0
  and position('require_current_legal_consents' in pg_get_functiondef(
    'public.request_my_account_deletion()'::regprocedure
  )) = 0,
  'legal recovery, onboarding, and account deletion remain exempt from the gate'
);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000471', 'append-only@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, city, country,
  latitude, longitude, onboarding_complete
) values (
  '00000000-0000-0000-0000-000000000471', 'History Member', 'History',
  '1990-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, true
);
insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select '00000000-0000-0000-0000-000000000471', document_type, version, 'reacceptance'
from halal_mode_private.legal_document_registry
where is_current;

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000471","role":"authenticated"}',
  true
);

select throws_ok(
  $$ update halal_mode_private.member_legal_consent_history
     set accepted_at = accepted_at
     where user_id = '00000000-0000-0000-0000-000000000471' $$,
  '42501',
  'Legal consent history is append-only',
  'authenticated traffic cannot update consent history'
);

select throws_ok(
  $$ delete from halal_mode_private.member_legal_consent_history
     where user_id = '00000000-0000-0000-0000-000000000471' $$,
  '42501',
  'Legal consent history is append-only',
  'authenticated traffic cannot delete consent history'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000471","role":"service_role"}',
  true
);
select lives_ok(
  $$ update halal_mode_private.member_legal_consent_history
     set accepted_at = accepted_at
     where user_id = '00000000-0000-0000-0000-000000000471' $$,
  'service-role maintenance can update consent history explicitly'
);

update halal_mode_private.legal_document_registry
set is_current = false
where document_type = 'terms';
insert into halal_mode_private.legal_document_registry (
  document_type, version, title, effective_date, url, is_current
) values (
  'terms', '2026-08-15', 'Terms of Service', '2026-08-15',
  'https://halalmo.de/terms', true
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000471","role":"authenticated"}',
  true
);
select throws_ok(
  $$ select public.get_my_blocked_members() $$,
  '42501',
  'Current legal documents must be accepted',
  'a stale member is rejected before the underlying member-facing RPC runs'
);

select * from finish();
rollback;
