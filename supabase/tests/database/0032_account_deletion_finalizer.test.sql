begin;

set local search_path = public, extensions;
select plan(4);

select ok(
  has_function_privilege('service_role', 'public.claim_account_deletion_requests(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_account_deletion_requests(integer)', 'EXECUTE'),
  'only the service worker can claim deletion requests'
);
select ok(
  has_function_privilege('service_role', 'public.record_account_deletion_failure(uuid, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_account_deletion_failure(uuid, text)', 'EXECUTE'),
  'only the service worker can record deletion failures'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000321', 'finalizer@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete, photos, audio_greeting_url) values
  ('00000000-0000-0000-0000-000000000321', 'Finalizer', 'Finalizer', '1990-01-01', 'female', true, array['member/a.jpg'], 'member/a.m4a');
insert into halal_mode_private.account_deletion_requests (user_id) values
  ('00000000-0000-0000-0000-000000000321');
update halal_mode_private.account_deletion_requests
set requested_at = now() - interval '31 days'
where user_id = '00000000-0000-0000-0000-000000000321';
do $$ begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end $$;

select is((select count(*)::int from claim_account_deletion_requests(1)), 1, 'the worker claims a pending request');
select is((select attempts from halal_mode_private.account_deletion_requests where user_id = '00000000-0000-0000-0000-000000000321'), 1, 'claiming records one retry-safe attempt');

select * from finish();
rollback;
