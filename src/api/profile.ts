import { MOCK_PREFERENCES, MOCK_SELF } from '@/data/mock';
import { requireSupabase, USE_MOCKS } from '@/lib/supabase';
import type { PrivatePreferences, Profile } from '@/types';

export async function fetchMyProfile(): Promise<Profile> {
  if (USE_MOCKS) return MOCK_SELF;

  const client = requireSupabase();
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .eq('id', (await client.auth.getUser()).data.user?.id ?? '')
    .single();
  if (error) throw error;
  return profileFromRow(data as Record<string, unknown>);
}

export async function updateMyProfile(patch: Partial<Profile>): Promise<void> {
  if (USE_MOCKS) {
    Object.assign(MOCK_SELF, patch);
    return;
  }

  const client = requireSupabase();
  const {
    data: { user },
    error: authError,
  } = await client.auth.getUser();
  if (authError) throw authError;
  if (!user) throw new Error('You must be signed in to update your profile.');

  // Never trust a caller-provided id for the target row. RLS and the database
  // trigger also enforce this boundary, but the client should be correct too.
  const changes = profilePatchToRow(patch);
  if (Object.keys(changes).length === 0) return;
  const { error } = await client.from('profiles').update(changes).eq('id', user.id);
  if (error) throw error;
}

/**
 * Private preferences never leave the owner's session. RLS restricts this table
 * to `auth.uid() = user_id`, and the matcher reads it only inside a security-
 * definer function that returns matches — never the preference rows themselves.
 */
export async function fetchMyPreferences(): Promise<PrivatePreferences> {
  if (USE_MOCKS) return MOCK_PREFERENCES;

  const client = requireSupabase();
  const { data, error } = await client
    .from('private_preferences')
    .select('*')
    .single();
  if (error) throw error;
  return preferencesFromRow(data as Record<string, unknown>);
}

export async function updateMyPreferences(
  patch: Partial<PrivatePreferences>
): Promise<void> {
  if (USE_MOCKS) {
    Object.assign(MOCK_PREFERENCES, patch);
    return;
  }

  const client = requireSupabase();
  const changes = preferencesPatchToRow(patch);
  if (Object.keys(changes).length === 0) return;
  const { error } = await client.from('private_preferences').update(changes);
  if (error) throw error;
}

function profileFromRow(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    name: String(row.name),
    firstName: String(row.first_name),
    age: ageFromDate(String(row.birth_date)),
    gender: row.gender as Profile['gender'],
    occupation: String(row.occupation ?? ''),
    education: row.education as string | undefined,
    city: String(row.city ?? ''),
    country: String(row.country ?? ''),
    bio: String(row.bio ?? ''),
    photos: (row.photos as string[] | null) ?? [],
    chips: (row.chips as string[] | null) ?? [],
    religiousPractice: row.religious_practice as Profile['religiousPractice'],
    timeline: row.timeline as Profile['timeline'],
    relocation: row.relocation as Profile['relocation'],
    familyGoals: row.family_goals as Profile['familyGoals'],
    languagesSpoken: (row.languages_spoken as string[] | null) ?? [],
    isVerified: Boolean(row.is_verified),
    audioGreetingUrl: row.audio_greeting_url as string | undefined,
    audioDurationSeconds: row.audio_duration_seconds as number | undefined,
  };
}

function profilePatchToRow(patch: Partial<Profile>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const fields: [keyof Profile, string][] = [
    ['name', 'name'],
    ['firstName', 'first_name'],
    ['occupation', 'occupation'],
    ['education', 'education'],
    ['city', 'city'],
    ['country', 'country'],
    ['bio', 'bio'],
    ['photos', 'photos'],
    ['chips', 'chips'],
    ['religiousPractice', 'religious_practice'],
    ['timeline', 'timeline'],
    ['relocation', 'relocation'],
    ['familyGoals', 'family_goals'],
    ['languagesSpoken', 'languages_spoken'],
    ['audioGreetingUrl', 'audio_greeting_url'],
    ['audioDurationSeconds', 'audio_duration_seconds'],
  ];
  for (const [property, column] of fields) {
    if (patch[property] !== undefined) row[column] = patch[property];
  }
  return row;
}

function preferencesFromRow(row: Record<string, unknown>): PrivatePreferences {
  return {
    minAge: Number(row.min_age),
    maxAge: Number(row.max_age),
    minHeightCm: Number(row.min_height_cm),
    maxHeightCm: Number(row.max_height_cm),
    preferredBuilds: (row.preferred_builds as string[] | null) ?? [],
    preferredCountries: (row.preferred_countries as string[] | null) ?? [],
    maxDistanceKm: Number(row.max_distance_km),
    preferredPractice: (row.preferred_practice as PrivatePreferences['preferredPractice'] | null) ?? [],
    desiredTimeline: (row.desired_timeline as PrivatePreferences['desiredTimeline'] | null) ?? [],
    ownHeightCm: Number(row.own_height_cm ?? 0),
    ownWeightKg: row.own_weight_kg as number | undefined,
    ownBuild: row.own_build as string | undefined,
  };
}

function preferencesPatchToRow(
  patch: Partial<PrivatePreferences>
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const fields: [keyof PrivatePreferences, string][] = [
    ['minAge', 'min_age'],
    ['maxAge', 'max_age'],
    ['minHeightCm', 'min_height_cm'],
    ['maxHeightCm', 'max_height_cm'],
    ['preferredBuilds', 'preferred_builds'],
    ['preferredCountries', 'preferred_countries'],
    ['maxDistanceKm', 'max_distance_km'],
    ['preferredPractice', 'preferred_practice'],
    ['desiredTimeline', 'desired_timeline'],
    ['ownHeightCm', 'own_height_cm'],
    ['ownWeightKg', 'own_weight_kg'],
    ['ownBuild', 'own_build'],
  ];
  for (const [property, column] of fields) {
    if (patch[property] !== undefined) row[column] = patch[property];
  }
  return row;
}

function ageFromDate(value: string): number {
  const birthDate = new Date(value);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const beforeBirthday =
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}
