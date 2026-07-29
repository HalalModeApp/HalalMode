/** True only when cached member data must not cross an auth boundary. */
export function hasAuthPrincipalChanged(
  previousUserId: string | null,
  nextUserId: string | null
): boolean {
  return previousUserId !== nextUserId;
}
