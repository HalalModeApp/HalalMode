/** True only when cached member data must not cross an auth boundary. */
export function hasAuthPrincipalChanged(
  previousUserId: string | null,
  nextUserId: string | null
): boolean {
  return previousUserId !== nextUserId;
}

/** Rejects stale profile-status responses after sign-out or account switching. */
export function canApplyProfileStatus(
  requestId: number,
  latestRequestId: number,
  responseUserId: string,
  activeUserId: string | null
): boolean {
  return requestId === latestRequestId && responseUserId === activeUserId;
}
