begin;

set local search_path = public, extensions;
select plan(6);

select ok(
  position('Profile media must use the media service' in pg_get_functiondef(
    'public.update_my_profile(jsonb)'::regprocedure
  )) > 0
  and position('?|' in pg_get_functiondef(
    'public.update_my_profile(jsonb)'::regprocedure
  )) > 0,
  'generic profile patches explicitly reject private media fields'
);

select ok(
  position('app.profile_media_rpc' in pg_get_functiondef(
    'public.guard_profile_client_update()'::regprocedure
  )) > 0
  and position('new.photos is distinct from old.photos' in pg_get_functiondef(
    'public.guard_profile_client_update()'::regprocedure
  )) > 0
  and position('new.audio_greeting_url is distinct from old.audio_greeting_url' in pg_get_functiondef(
    'public.guard_profile_client_update()'::regprocedure
  )) > 0,
  'the profile trigger preserves the dedicated media RPC boundary'
);

select ok(
  has_function_privilege('authenticated', 'public.update_my_profile(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.update_my_profile(jsonb)', 'EXECUTE'),
  'the safe profile updater retains its reviewed grants'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000005501', 'media-regression@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, photos, onboarding_complete
) values (
  '00000000-0000-0000-0000-000000005501', 'Media Regression', 'Media',
  '1990-01-01', 'female', array['existing/photo.jpg'], true
);
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000005501","role":"authenticated"}',
  true
);

select throws_ok(
  $$ select update_my_profile('{"photos":["https://example.test/tracker.jpg"]}'::jsonb) $$,
  '42501',
  'Profile media must use the media service',
  'an external photo URL cannot enter through the generic updater'
);

select is(
  (select photos from profiles where id = '00000000-0000-0000-0000-000000005501'),
  array['existing/photo.jpg']::text[],
  'a rejected generic media patch leaves photos unchanged'
);

select throws_ok(
  $$ select update_my_profile('{"audio_greeting_url":"https://example.test/voice.m4a"}'::jsonb) $$,
  '42501',
  'Profile media must use the media service',
  'an external voice URL cannot enter through the generic updater'
);

select * from finish();
rollback;
