export interface RoundInteractionState {
  inChosenZone: boolean;
  remaining: number;
  canPop: boolean;
}

/** Centralises interaction rules that must agree between state and UI. */
export function getRoundInteractionState(
  liveCount: number,
  keepLimit: number
): RoundInteractionState {
  const safeLiveCount = Math.max(0, Math.trunc(liveCount));
  const safeKeepLimit = Math.max(0, Math.trunc(keepLimit));
  return {
    inChosenZone: safeLiveCount > 0 && safeLiveCount <= safeKeepLimit,
    remaining: Math.max(0, safeLiveCount - safeKeepLimit),
    canPop: safeLiveCount > 1,
  };
}

/** Keeps the active card valid after a release without introducing a flash. */
export function resolveActiveId<T extends { id: string }>(
  live: readonly T[],
  requestedId: string | null
): string | null {
  if (requestedId && live.some((item) => item.id === requestedId)) {
    return requestedId;
  }
  return live[0]?.id ?? null;
}

/** Maps platform adjustable-control actions to the circular deck direction. */
export function deckDirectionForAccessibilityAction(
  action: 'increment' | 'decrement'
): 'next' | 'previous' {
  return action === 'increment' ? 'next' : 'previous';
}
