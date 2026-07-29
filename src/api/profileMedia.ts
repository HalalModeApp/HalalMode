import { File } from 'expo-file-system';

import { requireSupabase, USE_MOCKS } from '@/lib/supabase';
import type { Profile, ProfileMediaSource } from '@/types';

export const PROFILE_PHOTO_BUCKET = 'profile-photos';
export const VOICE_INTRODUCTION_BUCKET = 'voice-introductions';

export type ProfilePhotoMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/heic'
  | 'image/heif';

export type VoiceIntroductionMimeType =
  | 'audio/mp4'
  | 'audio/x-m4a'
  | 'audio/aac'
  | 'audio/mpeg'
  | 'audio/webm';

export interface LocalProfileMedia {
  uri: string;
  mimeType: ProfilePhotoMimeType | VoiceIntroductionMimeType;
}

export interface VoiceIntroductionUpload {
  path: string;
  /** A private object left for a later cleanup retry, never a profile reference. */
  cleanupPendingPath?: string;
}

const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const VOICE_LIMIT_BYTES = 15 * 1024 * 1024;
// Long enough for an uninterrupted foreground session. Returning to the app
// also refetches stale queries, which rotates these URLs before reuse.
const SIGNED_URL_SECONDS = 60 * 60;
const PHOTO_STORAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif)$/;
const VOICE_STORAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(m4a|aac|mp3|webm)$/;

/** Uploads a private object, then atomically attaches its verified path to the profile. */
export async function uploadProfilePhoto(
  media: LocalProfileMedia & { mimeType: ProfilePhotoMimeType }
): Promise<{ path: string; photos: string[] }> {
  if (USE_MOCKS) return { path: media.uri, photos: [media.uri] };

  const client = requireSupabase();
  const body = await readLocalMedia(media.uri, PHOTO_LIMIT_BYTES);
  const path = await createServerMediaPath('photo', media.mimeType);
  const { error: uploadError } = await client.storage
    .from(PROFILE_PHOTO_BUCKET)
    .upload(path, body, { contentType: media.mimeType, upsert: false, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data, error: attachError } = await client.rpc('attach_profile_photo', {
    p_path: path,
  });
  if (attachError) {
    const cleanup = await client.storage.from(PROFILE_PHOTO_BUCKET).remove([path]);
    if (cleanup.error) {
      throw new Error(`${attachError.message} The unused upload also needs cleanup: ${path}`);
    }
    throw attachError;
  }
  return { path, photos: (data ?? []) as string[] };
}

/** Detaches authoritatively; byte cleanup is best-effort and must not roll back UI state. */
export async function deleteProfilePhoto(path: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { data, error } = await client.rpc('delete_profile_photo', { p_path: path });
  if (error) throw error;
  await client.storage.from(PROFILE_PHOTO_BUCKET).remove([String(data)]);
}

/** Replaces the private voice introduction and reports any old object needing cleanup. */
export async function uploadVoiceIntroduction(
  media: LocalProfileMedia & { mimeType: VoiceIntroductionMimeType },
  durationSeconds: number
): Promise<VoiceIntroductionUpload> {
  if (USE_MOCKS) return { path: media.uri };

  const client = requireSupabase();
  const body = await readLocalMedia(media.uri, VOICE_LIMIT_BYTES);
  const path = await createServerMediaPath('voice', media.mimeType);
  const { error: uploadError } = await client.storage
    .from(VOICE_INTRODUCTION_BUCKET)
    .upload(path, body, { contentType: media.mimeType, upsert: false, cacheControl: '3600' });
  if (uploadError) throw uploadError;

  const { data, error: attachError } = await client.rpc('attach_voice_introduction', {
    p_path: path,
    p_duration_seconds: Math.round(durationSeconds),
  });
  if (attachError) {
    const cleanup = await client.storage.from(VOICE_INTRODUCTION_BUCKET).remove([path]);
    if (cleanup.error) {
      throw new Error(`${attachError.message} The unused upload also needs cleanup: ${path}`);
    }
    throw attachError;
  }

  const result = data as { path: string; previousPath?: string | null };
  if (!result.previousPath || result.previousPath === result.path) return { path: result.path };
  const cleanup = await client.storage
    .from(VOICE_INTRODUCTION_BUCKET)
    .remove([result.previousPath]);
  return cleanup.error
    ? { path: result.path, cleanupPendingPath: result.previousPath }
    : { path: result.path };
}

export async function deleteVoiceIntroduction(path: string): Promise<void> {
  if (USE_MOCKS) return;
  const client = requireSupabase();
  const { data, error } = await client.rpc('delete_voice_introduction', { p_path: path });
  if (error) throw error;
  await client.storage.from(VOICE_INTRODUCTION_BUCKET).remove([String(data)]);
}

/** Resolves a private path only while Storage RLS says the viewer may see it. */
export async function createProfileMediaSignedUrl(
  bucket: typeof PROFILE_PHOTO_BUCKET | typeof VOICE_INTRODUCTION_BUCKET,
  path: string,
  expiresInSeconds = SIGNED_URL_SECONDS
): Promise<string> {
  if (USE_MOCKS) return path;
  const { data, error } = await requireSupabase().storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Converts database storage paths into renderable signed URLs. Existing
 * HTTPS, mock, data, and bundled references pass through unchanged, which
 * keeps rollout compatible with profiles created before private buckets.
 */
export async function hydrateProfileMedia(profile: Profile): Promise<Profile> {
  if (USE_MOCKS) return profile;

  const photoMedia = await Promise.all(
    profile.photos.map(async (value): Promise<ProfileMediaSource> => {
      if (!PHOTO_STORAGE_PATH.test(value)) return { displayUrl: value };
      return {
        storagePath: value,
        displayUrl: await createProfileMediaSignedUrl(PROFILE_PHOTO_BUCKET, value),
      };
    })
  );

  const voicePath = profile.audioGreetingUrl;
  const signedVoice = voicePath && VOICE_STORAGE_PATH.test(voicePath)
    ? await createProfileMediaSignedUrl(VOICE_INTRODUCTION_BUCKET, voicePath)
    : voicePath;

  return {
    ...profile,
    photos: photoMedia.map((media) => media.displayUrl),
    photoMedia,
    audioGreetingUrl: signedVoice,
    audioGreetingStoragePath:
      voicePath && VOICE_STORAGE_PATH.test(voicePath) ? voicePath : undefined,
  };
}

async function createServerMediaPath(
  mediaType: 'photo' | 'voice',
  mimeType: ProfilePhotoMimeType | VoiceIntroductionMimeType
): Promise<string> {
  const { data, error } = await requireSupabase().rpc('create_profile_media_path', {
    p_media_type: mediaType,
    p_mime_type: mimeType,
  });
  if (error) throw error;
  if (typeof data !== 'string' || !data) throw new Error('The media service did not return an upload path.');
  return data;
}

async function readLocalMedia(uri: string, maxBytes: number): Promise<ArrayBuffer> {
  if (!uri.startsWith('file://') && !uri.startsWith('content://')) {
    throw new Error('Choose media stored on this device.');
  }
  const file = new File(uri);
  if (!file.exists) throw new Error('The selected media file is no longer available.');
  if (file.size <= 0 || file.size > maxBytes) {
    throw new Error(`The selected file must be smaller than ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }
  return file.arrayBuffer();
}
