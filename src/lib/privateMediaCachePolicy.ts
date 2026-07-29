/** A cached private image must not survive a switch to another member. */
export function shouldClearPrivateMediaCache(previousMemberId: string | null, nextMemberId: string | null): boolean {
  return previousMemberId !== null && previousMemberId !== nextMemberId;
}
