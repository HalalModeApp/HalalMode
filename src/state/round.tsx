import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { fetchCurrentRound, releaseIntroduction, submitKeeps } from '@/api/introductions';
import { queryKeys } from '@/lib/queryClient';
import { getRoundInteractionState, resolveActiveId } from '@/lib/roundInvariants';
import { useAuth } from '@/state/auth';
import { useSession } from '@/state/session';
import { TIER_LIMITS, type Introduction, type IntroductionRound } from '@/types';

interface RoundValue {
  round: IntroductionRound | undefined;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;

  /** Introductions still in play — released ones are filtered out. */
  live: Introduction[];
  activeId: string | null;
  active: Introduction | null;

  /** How many the member may keep at their tier. */
  keepLimit: number;
  /** True once `live.length` has come down to the keep limit. */
  inChosenZone: boolean;
  /** How many still need releasing before the set is decided. */
  remaining: number;

  /**
    * Always false once the set has narrowed to the keepable few — see the
    * provider. The screen can use this directly without re-guarding it.
    */
  popMode: boolean;
  togglePopMode: () => void;
  /** False in the chosen zone, so the toggle can be hidden rather than dead. */
  canPop: boolean;

  setActive: (id: string) => void;
  release: (id: string) => void;
  releaseError: string | null;
  retryRelease: () => void;
  clearReleaseError: () => void;

  submitting: boolean;
  /** Commits the surviving introductions. Resolves with the mutual matches. */
  submit: (keptIntroductionIds?: string[]) => Promise<string[]>;
  /** True once keeps are submitted — drives the "Nothing more today" state. */
  submitted: boolean;
  submitError: string | null;

  reset: () => void;
}

const RoundContext = createContext<RoundValue | null>(null);

/**
 * Owns the interaction state for the current round.
 *
 * Lives above the tab navigator so a trip into a profile and back does not
 * reset which faces have been let go — the reference lost that state on every
 * screen change, which made the set feel undecided.
 */
export function RoundProvider({ children }: { children: ReactNode }) {
  const { tier } = useSession();
  const { user } = useAuth();
  const memberId = user?.id;
  const queryClient = useQueryClient();

  const [released, setReleased] = useState<Record<string, true>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [popMode, setPopMode] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [releasing, setReleasing] = useState<Record<string, true>>({});
  const [releaseFailure, setReleaseFailure] = useState<{ id: string; message: string } | null>(null);

  const {
    data: round,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [...queryKeys.round, tier],
    queryFn: () => fetchCurrentRound(tier),
  });

  const keepLimit = TIER_LIMITS[tier].keeps;

  const live = useMemo(
    () => (round?.introductions ?? []).filter((item) => !released[item.id]),
    [round, released]
  );

  // Falls back to the first survivor whenever the active card is released.
  const resolvedActiveId = useMemo(
    () => resolveActiveId(live, activeId),
    [activeId, live]
  );

  const active = useMemo(
    () => live.find((item) => item.id === resolvedActiveId) ?? null,
    [live, resolvedActiveId]
  );

  const { inChosenZone, remaining, canPop } = getRoundInteractionState(
    live.length,
    keepLimit
  );

  // Reaching the keepable few ends the current popping gesture, but does not
  // lock the final set: members may still narrow it further if they choose.
  useEffect(() => {
    if (inChosenZone) setPopMode(false);
  }, [inChosenZone]);

  const releaseMutation = useMutation({ mutationFn: releaseIntroduction });

  const release = useCallback(
    (id: string) => {
      if (released[id] || releasing[id]) return;
      setReleasing((current) => ({ ...current, [id]: true }));
      setReleaseFailure(null);
      setReleased((current) => ({ ...current, [id]: true }));
      releaseMutation.mutate(id, {
        onError: (failure) => {
          setReleased((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setReleaseFailure({
            id,
            message: failure instanceof Error
              ? failure.message
              : 'We could not save that choice. Nothing was changed.',
          });
        },
        onSettled: () => {
          setReleasing((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        },
      });
    },
    [released, releaseMutation, releasing]
  );

  const retryRelease = useCallback(() => {
    if (releaseFailure) release(releaseFailure.id);
  }, [release, releaseFailure]);

  const submitMutation = useMutation({
    mutationFn: async (keptIntroductionIds: string[]) => {
      if (!round) return { mutualProfileIds: [] };
      return submitKeeps(round.id, keptIntroductionIds);
    },
    onSuccess: () => {
      setSubmitted(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });

  const submit = useCallback(
    async (keptIntroductionIds = live.map((item) => item.id)) => {
      const result = await submitMutation.mutateAsync(keptIntroductionIds);
      return result.mutualProfileIds;
    },
    [live, submitMutation]
  );

  const reset = useCallback(() => {
    setReleased({});
    setReleasing({});
    setReleaseFailure(null);
    setActiveId(null);
    setPopMode(false);
    setSubmitted(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.round });
  }, [queryClient]);

  useEffect(() => {
    // Query data is cleared at the auth boundary. These are interaction-local
    // values, so reset them separately before a different member sees a round.
    setReleased({});
    setReleasing({});
    setReleaseFailure(null);
    setActiveId(null);
    setPopMode(false);
    setSubmitted(false);
  }, [memberId]);

  const value = useMemo<RoundValue>(
    () => ({
      round,
      isLoading,
      error: (error as Error) ?? null,
      refresh: () => void refetch(),
      live,
      activeId: resolvedActiveId,
      active,
      keepLimit,
      inChosenZone,
      remaining,
      // Hard guard, not a UI condition: once these are the ones being kept,
      // there is no state in which a tap should release them by accident.
      popMode,
      canPop,
      togglePopMode: () => {
        if (live.length <= 1) return;
        setPopMode((on) => !on);
      },
      setActive: setActiveId,
      release,
      releaseError: releaseFailure?.message ?? null,
      retryRelease,
      clearReleaseError: () => setReleaseFailure(null),
      submitting: submitMutation.isPending,
      submit,
      submitted,
      submitError: submitMutation.error instanceof Error ? submitMutation.error.message : null,
      reset,
    }),
    [
      round,
      isLoading,
      error,
      refetch,
      live,
      resolvedActiveId,
      active,
      keepLimit,
      inChosenZone,
      remaining,
      canPop,
      popMode,
      release,
      releaseFailure,
      retryRelease,
      submitMutation.isPending,
      submit,
      submitted,
      submitMutation.error,
      reset,
    ]
  );

  return <RoundContext.Provider value={value}>{children}</RoundContext.Provider>;
}

export function useRound(): RoundValue {
  const value = useContext(RoundContext);
  if (!value) throw new Error('useRound must be used inside <RoundProvider>');
  return value;
}
