export const ONBOARDING_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function onboardingDraftExpiresAt(now = Date.now()): number {
  return now + ONBOARDING_DRAFT_TTL_MS;
}

export function isOnboardingDraftCurrent(expiresAt: unknown, now = Date.now()): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now;
}
