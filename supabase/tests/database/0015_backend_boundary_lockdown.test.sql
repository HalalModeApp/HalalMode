begin;

set local search_path = public, extensions;
select plan(20);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'profiles' and cmd = 'SELECT'),
  1,
  'profiles retain only the owner SELECT policy'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
  'authenticated cannot update raw profile rows'
);
select ok(
  not has_table_privilege('authenticated', 'public.introduction_selections', 'INSERT'),
  'authenticated cannot forge selection inserts'
);
select ok(
  not has_table_privilege('authenticated', 'public.introduction_selections', 'UPDATE'),
  'authenticated cannot rewrite selection identity'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'introduction_selections' and cmd in ('INSERT', 'UPDATE')),
  0,
  'selection write policies were removed'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.introduction_selections'::regclass
      and tgname = 'introduction_selections_identity_guard'
      and not tgisinternal
  ),
  'selection identity has a database invariant guard'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'question_picks' and cmd = 'SELECT'),
  1,
  'question picks retain an owner read policy'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'question_picks' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
  0,
  'question pick writes are RPC-only'
);
select ok(
  has_function_privilege('authenticated', 'public.update_my_profile(jsonb)', 'EXECUTE'),
  'authenticated can call the safe profile update RPC'
);
select ok(
  not has_function_privilege('anon', 'public.update_my_profile(jsonb)', 'EXECUTE'),
  'anon cannot call the profile update RPC'
);
select ok(
  has_function_privilege('authenticated', 'public.release_introduction(uuid)', 'EXECUTE'),
  'authenticated can release their live introduction through the RPC'
);
select ok(
  not has_function_privilege('anon', 'public.get_current_round()', 'EXECUTE'),
  'anon cannot call authenticated round RPCs'
);
select ok(
  not has_function_privilege('authenticated', 'public.refresh_connection_stage_after_answer(uuid)', 'EXECUTE'),
  'connection stage helper is internal-only'
);
select ok(
  not has_function_privilege('authenticated', 'public.build_connection_recap(uuid)', 'EXECUTE'),
  'recap builder is internal-only'
);
select ok(
  not has_function_privilege('authenticated', 'public.safe_member_profile(public.profiles)', 'EXECUTE'),
  'raw profile DTO helper is internal-only'
);
select ok(
  position('p_profile.first_name' in pg_get_functiondef('public.safe_member_profile(public.profiles)'::regprocedure)) > 0
    and position('''name'', p_profile.name' in pg_get_functiondef('public.safe_member_profile(public.profiles)'::regprocedure)) = 0,
  'cross-member DTO does not serialize the stored full name'
);
select ok(
  position('myQuestionPicksSubmitted' in pg_get_functiondef(
    'halal_mode_private.get_connection_after_legal_consent(uuid)'::regprocedure
  )) > 0
    and position('theirQuestionPicksSubmitted' in pg_get_functiondef(
      'halal_mode_private.get_connection_after_legal_consent(uuid)'::regprocedure
    )) > 0
    and position('get_connection_after_legal_consent' in pg_get_functiondef(
      'public.get_connection(uuid)'::regprocedure
    )) > 0,
  'the gated connection DTO reports both question-pick submission states'
);
select ok(
  has_function_privilege('service_role', 'public.verify_round_scheduler_secret(text)', 'EXECUTE'),
  'service role can verify scheduler credentials'
);
select ok(
  not has_function_privilege('authenticated', 'public.verify_round_scheduler_secret(text)', 'EXECUTE'),
  'members cannot use scheduler verification'
);
select ok(
  exists (select 1 from vault.secrets where name = 'halal_mode_round_scheduler'),
  'scheduler credential exists in Vault'
);

select * from finish();
rollback;
