/** True only when cached member data must not cross an auth boundary. */
export function hasAuthPrincipalChanged(
  previousUserId: string | null,
  nextUserId: string | null
): boolean {
  return previousUserId !== nextUserId;
}

/**
 * A member-facing “Sign out” action must affect this device only. Session-wide
 * revocation is a separate account-security control, not an implicit side
 * effect of leaving one phone.
 */
export const MEMBER_SIGN_OUT_SCOPE = 'local' as const;

/** Rejects stale profile-status responses after sign-out or account switching. */
export function canApplyProfileStatus(
  requestId: number,
  latestRequestId: number,
  responseUserId: string,
  activeUserId: string | null
): boolean {
  return requestId === latestRequestId && responseUserId === activeUserId;
}
