begin;

set local search_path = public, extensions;
select plan(24);

select is(
  (select count(*)::int from storage.buckets where id in ('profile-photos', 'voice-introductions')),
  2,
  'both profile media buckets exist'
);
select ok(
  not exists (
    select 1 from storage.buckets
    where id in ('profile-photos', 'voice-introductions') and public
  ),
  'profile media buckets are private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'profile-photos'),
  10485760::bigint,
  'photo uploads are capped at 10 MB'
);
select is(
  (select file_size_limit from storage.buckets where id = 'voice-introductions'),
  15728640::bigint,
  'voice introductions are capped at 15 MB'
);
select ok(
  (select allowed_mime_types @> array['image/jpeg', 'image/png'] from storage.buckets where id = 'profile-photos')
  and (select allowed_mime_types @> array['audio/mp4', 'audio/mpeg'] from storage.buckets where id = 'voice-introductions'),
  'bucket MIME allowlists are configured'
);
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('profile media owner upload', 'profile media authorized read', 'profile media owner delete')),
  3,
  'upload, authorized-read, and owner-delete policies exist'
);
select ok(
  has_function_privilege('authenticated', 'public.attach_profile_photo(text)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.attach_voice_introduction(text,integer)', 'EXECUTE'),
  'authenticated members can call media attachment RPCs'
);
select ok(
  not has_function_privilege('anon', 'public.attach_profile_photo(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.attach_voice_introduction(text,integer)', 'EXECUTE'),
  'anonymous callers cannot attach profile media'
);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000e5', 'profile-media@example.test'),
  ('00000000-0000-0000-0000-0000000000f6', 'visible-media@example.test');
insert into profiles (id, name, first_name, birth_date, gender, onboarding_complete)
values
  ('00000000-0000-0000-0000-0000000000e5', 'Media Member', 'Media', '1990-01-01', 'female', true),
  ('00000000-0000-0000-0000-0000000000f6', 'Visible Member', 'Visible', '1990-01-01', 'male', true);

insert into rounds (id, user_id, tier, expires_at)
values (
  '00000000-0000-0000-0000-000000003001',
  '00000000-0000-0000-0000-0000000000e5',
  'free', now() + interval '1 hour'
);
insert into introductions (id, round_id, viewer_id, subject_id)
values (
  '00000000-0000-0000-0000-000000003002',
  '00000000-0000-0000-0000-000000003001',
  '00000000-0000-0000-0000-0000000000e5',
  '00000000-0000-0000-0000-0000000000f6'
);

do $$ begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}', true);
end $$;

select ok(
  halal_mode_private.can_read_profile_media('00000000-0000-0000-0000-0000000000f6'),
  'a live introduction authorizes private profile media reads'
);
insert into blocks (blocker_id, blocked_id)
values ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000e5');
select ok(
  not halal_mode_private.can_read_profile_media('00000000-0000-0000-0000-0000000000f6'),
  'a block in either direction revokes private media reads'
);

create temporary table generated_media_paths (kind text primary key, path text not null) on commit drop;
insert into generated_media_paths values
  ('photo', create_profile_media_path('photo', 'image/jpeg')),
  ('voice', create_profile_media_path('voice', 'audio/mp4'));

select ok(
  (select path ~ '^00000000-0000-0000-0000-0000000000e5/[0-9a-f-]{36}\.jpg$' from generated_media_paths where kind = 'photo'),
  'photo upload path is server-generated below the member folder'
);
select throws_ok(
  $$ select attach_profile_photo('file:///private/photo.jpg') $$,
  '22023', 'Invalid profile photo path',
  'device file URIs cannot be attached to a profile'
);

insert into storage.objects (bucket_id, name, metadata)
select 'profile-photos', path, '{"mimetype":"image/jpeg","size":1024}'::jsonb
from generated_media_paths where kind = 'photo';

select is(
  attach_profile_photo((select path from generated_media_paths where kind = 'photo')),
  array[(select path from generated_media_paths where kind = 'photo')],
  'a verified uploaded photo is attached'
);
select is(
  cardinality(attach_profile_photo((select path from generated_media_paths where kind = 'photo'))),
  1,
  'photo attachment is idempotent'
);
select ok(
  not halal_mode_private.can_delete_profile_media(
    'profile-photos', (select path from generated_media_paths where kind = 'photo')
  ),
  'raw Storage deletion is denied while a photo is attached'
);
select throws_ok(
  $$ select update_my_profile('{"photos":["https://example.test/tracker.jpg"]}'::jsonb) $$,
  '42501', 'Profile media must use the media service',
  'generic profile updates cannot inject an external photo URL'
);
select is(
  delete_profile_photo((select path from generated_media_paths where kind = 'photo')),
  (select path from generated_media_paths where kind = 'photo'),
  'photo deletion returns the owned path for Storage API removal'
);
select is(
  (select cardinality(photos) from profiles where id = '00000000-0000-0000-0000-0000000000e5'),
  0,
  'photo deletion detaches the profile reference'
);
select ok(
  halal_mode_private.can_delete_profile_media(
    'profile-photos', (select path from generated_media_paths where kind = 'photo')
  ),
  'Storage deletion is authorized after the profile RPC detaches the photo'
);

insert into storage.objects (bucket_id, name, metadata)
select 'voice-introductions', path, '{"mimetype":"audio/mp4","size":2048}'::jsonb
from generated_media_paths where kind = 'voice';

select is(
  attach_voice_introduction(
    (select path from generated_media_paths where kind = 'voice'), 42
  )->>'path',
  (select path from generated_media_paths where kind = 'voice'),
  'a verified private voice introduction is attached'
);
select is(
  (select audio_duration_seconds from profiles where id = '00000000-0000-0000-0000-0000000000e5'),
  42,
  'voice duration is stored server-side'
);
select throws_ok(
  $$ select attach_voice_introduction('https://example.test/voice.m4a', 42) $$,
  '22023', 'Invalid voice introduction path',
  'external voice URLs cannot be attached'
);
select is(
  delete_voice_introduction((select path from generated_media_paths where kind = 'voice')),
  (select path from generated_media_paths where kind = 'voice'),
  'voice deletion returns the owned path for Storage API removal'
);
select ok(
  (select audio_greeting_url is null and audio_duration_seconds is null
   from profiles where id = '00000000-0000-0000-0000-0000000000e5'),
  'voice deletion clears both profile fields'
);

select * from finish();
rollback;
