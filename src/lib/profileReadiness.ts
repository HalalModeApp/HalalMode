export interface ProfileReadinessInput {
  firstName?: string | null;
  city?: string | null;
  country?: string | null;
  bio?: string | null;
  photoCount?: number | null;
}

export type ProfileReadinessIssue = 'name' | 'location' | 'bio' | 'photo';

/** Pure policy; enforce server-side only after migration/backfill approval. */
export function getProfileReadiness(input: ProfileReadinessInput) {
  const missing: ProfileReadinessIssue[] = [];
  if (!input.firstName?.trim()) missing.push('name');
  if (!input.city?.trim() || !input.country?.trim()) missing.push('location');
  if ((input.bio?.trim().length ?? 0) < 40) missing.push('bio');
  if ((input.photoCount ?? 0) < 1) missing.push('photo');
  return { ready: missing.length === 0, missing };
}
