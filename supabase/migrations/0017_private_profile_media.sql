-- Private profile media. Database rows store bucket-relative paths only; raw
-- device URIs and arbitrary external URLs never become profile attributes.

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values
  (
    'profile-photos', 'profile-photos', false, 10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  ),
  (
    'voice-introductions', 'voice-introductions', false, 15728640,
    array['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm']
  )
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create schema if not exists halal_mode_private;
revoke all on schema halal_mode_private from public, anon, authenticated;
grant usage on schema halal_mode_private to authenticated;

create index if not exists introductions_viewer_subject_idx
  on introductions (viewer_id, subject_id);
create index if not exists blocks_blocked_blocker_idx
  on blocks (blocked_id, blocker_id);

-- Kept outside the exposed public API schema so callers cannot use it as a
-- relationship oracle. The Storage RLS policy is its only client-side caller.
create or replace function halal_mode_private.can_read_profile_media(p_subject_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_viewer uuid := auth.uid();
  v_subject uuid;
begin
  if v_viewer is null then return false; end if;
  if p_subject_id = v_viewer::text then return true; end if;
  if p_subject_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_subject := p_subject_id::uuid;

  if exists (
    select 1 from blocks b
    where (b.blocker_id = v_viewer and b.blocked_id = v_subject)
       or (b.blocker_id = v_subject and b.blocked_id = v_viewer)
  ) then return false; end if;

  return exists (
    select 1
    from introductions i
    join rounds r on r.id = i.round_id
    where i.viewer_id = v_viewer
      and i.subject_id = v_subject
      and r.submitted_at is null
      and r.expires_at > now()
  ) or exists (
    select 1 from connections c
    where c.closed_at is null
      and (
        (c.user_a = v_viewer and c.user_b = v_subject)
        or (c.user_b = v_viewer and c.user_a = v_subject)
      )
  );
end;
$$;
revoke all on function halal_mode_private.can_read_profile_media(text) from public, anon, authenticated;
grant execute on function halal_mode_private.can_read_profile_media(text) to authenticated;

-- Storage deletion is allowed only after the dedicated profile RPC detached
-- the path, or for an upload that was never attached. This prevents a crafted
-- direct Storage request from leaving a live profile with a broken media path.
create or replace function halal_mode_private.can_delete_profile_media(
  p_bucket_id text,
  p_path text
) returns boolean
language plpgsql
stable
security definer
set search_path = public as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or split_part(p_path, '/', 1) <> v_user::text then return false; end if;
  if p_bucket_id = 'profile-photos' then
    return not exists (
      select 1 from profiles p where p.id = v_user and p_path = any(p.photos)
    );
  elsif p_bucket_id = 'voice-introductions' then
    return not exists (
      select 1 from profiles p where p.id = v_user and p.audio_greeting_url = p_path
    );
  end if;
  return false;
end;
$$;
revoke all on function halal_mode_private.can_delete_profile_media(text, text) from public, anon, authenticated;
grant execute on function halal_mode_private.can_delete_profile_media(text, text) to authenticated;

-- Storage paths are exactly <auth.uid()>/<server-generated uuid>.<extension>.
drop policy if exists "profile media owner upload" on storage.objects;
create policy "profile media owner upload"
on storage.objects for insert to authenticated
with check (
  bucket_id in ('profile-photos', 'voice-introductions')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (
    (
      bucket_id = 'profile-photos'
      and name ~ (
        '^' || (select auth.uid()::text)
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$'
      )
    )
    or
    (
      bucket_id = 'voice-introductions'
      and name ~ (
        '^' || (select auth.uid()::text)
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(m4a|aac|mp3|webm)$'
      )
    )
  )
);

drop policy if exists "profile media authorized read" on storage.objects;
create policy "profile media authorized read"
on storage.objects for select to authenticated
using (
  bucket_id in ('profile-photos', 'voice-introductions')
  and halal_mode_private.can_read_profile_media((storage.foldername(name))[1])
);

drop policy if exists "profile media owner delete" on storage.objects;
create policy "profile media owner delete"
on storage.objects for delete to authenticated
using (
  bucket_id in ('profile-photos', 'voice-introductions')
  and halal_mode_private.can_delete_profile_media(bucket_id, name)
);

-- Media fields may change only inside the dedicated RPCs below. This remains a
-- second line of defence even though authenticated users have no raw profile
-- UPDATE grant after migration 0015.
create or replace function guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    if coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
       and coalesce(current_setting('app.account_control_rpc', true), '') <> 'true'
       and (
         new.tier is distinct from old.tier
         or new.is_verified is distinct from old.is_verified
         or new.onboarding_complete is distinct from old.onboarding_complete
         or new.is_paused is distinct from old.is_paused
         or new.birth_date is distinct from old.birth_date
         or new.gender is distinct from old.gender
       ) then
      raise exception 'Profile field is server controlled' using errcode = '42501';
    end if;

    if coalesce(current_setting('app.profile_media_rpc', true), '') <> 'true'
       and (
         new.photos is distinct from old.photos
         or new.audio_greeting_url is distinct from old.audio_greeting_url
         or new.audio_duration_seconds is distinct from old.audio_duration_seconds
       ) then
      raise exception 'Profile media must use the media service' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function create_profile_media_path(
  p_media_type text,
  p_mime_type text
) returns text
language plpgsql
volatile
security definer
set search_path = public as $$
declare
  v_extension text;
begin
  if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;

  v_extension := case
    when p_media_type = 'photo' and p_mime_type = 'image/jpeg' then 'jpg'
    when p_media_type = 'photo' and p_mime_type = 'image/png' then 'png'
    when p_media_type = 'photo' and p_mime_type = 'image/webp' then 'webp'
    when p_media_type = 'photo' and p_mime_type = 'image/heic' then 'heic'
    when p_media_type = 'photo' and p_mime_type = 'image/heif' then 'heif'
    when p_media_type = 'voice' and p_mime_type in ('audio/mp4', 'audio/x-m4a') then 'm4a'
    when p_media_type = 'voice' and p_mime_type = 'audio/aac' then 'aac'
    when p_media_type = 'voice' and p_mime_type = 'audio/mpeg' then 'mp3'
    when p_media_type = 'voice' and p_mime_type = 'audio/webm' then 'webm'
    else null
  end;
  if v_extension is null then raise exception 'Unsupported profile media type' using errcode = '22023'; end if;

  return auth.uid()::text || '/' || gen_random_uuid()::text || '.' || v_extension;
end;
$$;

create or replace function attach_profile_photo(p_path text)
returns text[]
language plpgsql
security definer
set search_path = public, storage as $$
declare
  v_photos text[];
begin
  if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if p_path is null or p_path !~ (
    '^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$'
  ) then raise exception 'Invalid profile photo path' using errcode = '22023'; end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'profile-photos'
      and o.name = p_path
      and lower(coalesce(o.metadata->>'mimetype', '')) in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  ) then raise exception 'Uploaded profile photo was not found' using errcode = 'P0002'; end if;

  select photos into v_photos from profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
  if p_path = any(v_photos) then return v_photos; end if;
  if cardinality(v_photos) >= 6 then raise exception 'Choose at most six photos' using errcode = '22023'; end if;

  perform set_config('app.profile_media_rpc', 'true', true);
  update profiles set photos = array_append(v_photos, p_path) where id = auth.uid()
  returning photos into v_photos;
  perform set_config('app.profile_media_rpc', 'false', true);
  return v_photos;
end;
$$;

create or replace function delete_profile_photo(p_path text)
returns text
language plpgsql
security definer
set search_path = public as $$
declare
  v_photos text[];
begin
  if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if p_path is null or p_path !~ (
    '^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif)$'
  ) then raise exception 'Invalid profile photo path' using errcode = '22023'; end if;

  select photos into v_photos from profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
  if p_path = any(v_photos) then
    perform set_config('app.profile_media_rpc', 'true', true);
    update profiles set photos = array_remove(v_photos, p_path) where id = auth.uid();
    perform set_config('app.profile_media_rpc', 'false', true);
  end if;
  -- Returning an already-detached owned path makes Storage API deletion safely retryable.
  return p_path;
end;
$$;

create or replace function attach_voice_introduction(
  p_path text,
  p_duration_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = public, storage as $$
declare
  v_previous_path text;
begin
  if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if p_duration_seconds is null or p_duration_seconds not between 1 and 120 then
    raise exception 'Voice introduction must be between 1 and 120 seconds' using errcode = '22023';
  end if;
  if p_path is null or p_path !~ (
    '^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(m4a|aac|mp3|webm)$'
  ) then raise exception 'Invalid voice introduction path' using errcode = '22023'; end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'voice-introductions'
      and o.name = p_path
      and lower(coalesce(o.metadata->>'mimetype', '')) in ('audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/webm')
  ) then raise exception 'Uploaded voice introduction was not found' using errcode = 'P0002'; end if;

  select audio_greeting_url into v_previous_path
  from profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;

  perform set_config('app.profile_media_rpc', 'true', true);
  update profiles
  set audio_greeting_url = p_path, audio_duration_seconds = p_duration_seconds
  where id = auth.uid();
  perform set_config('app.profile_media_rpc', 'false', true);

  return jsonb_build_object('path', p_path, 'previousPath', v_previous_path);
end;
$$;

create or replace function delete_voice_introduction(p_path text)
returns text
language plpgsql
security definer
set search_path = public as $$
declare
  v_current_path text;
begin
  if auth.uid() is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if p_path is null or p_path !~ (
    '^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(m4a|aac|mp3|webm)$'
  ) then raise exception 'Invalid voice introduction path' using errcode = '22023'; end if;

  select audio_greeting_url into v_current_path
  from profiles where id = auth.uid() for update;
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
  if v_current_path = p_path then
    perform set_config('app.profile_media_rpc', 'true', true);
    update profiles
    set audio_greeting_url = null, audio_duration_seconds = null
    where id = auth.uid();
    perform set_config('app.profile_media_rpc', 'false', true);
  end if;
  return p_path;
end;
$$;

revoke all on function create_profile_media_path(text, text) from public, anon, authenticated;
revoke all on function attach_profile_photo(text) from public, anon, authenticated;
revoke all on function delete_profile_photo(text) from public, anon, authenticated;
revoke all on function attach_voice_introduction(text, int) from public, anon, authenticated;
revoke all on function delete_voice_introduction(text) from public, anon, authenticated;

grant execute on function create_profile_media_path(text, text) to authenticated;
grant execute on function attach_profile_photo(text) to authenticated;
grant execute on function delete_profile_photo(text) to authenticated;
grant execute on function attach_voice_introduction(text, int) to authenticated;
grant execute on function delete_voice_introduction(text) to authenticated;
