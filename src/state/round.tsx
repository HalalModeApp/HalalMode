import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import {
  fetchCurrentRoundState,
  passIntroduction,
  releaseIntroduction,
  softSelectIntroduction,
  submitKeeps,
} from '@/api/introductions';
import { DwellLedger, inferPassCandidate, inferSoftSelect } from '@/lib/dwell';
import type { DailyRoundEmptyReason, NarrowingCriterion } from '@/lib/dailyRoundState';
import { queryKeys } from '@/lib/queryClient';
import { getRoundInteractionState, resolveActiveId } from '@/lib/roundInvariants';
import { useAuth } from '@/state/auth';
import { useSession } from '@/state/session';
import { TIER_LIMITS, type Introduction, type IntroductionRound } from '@/types';

interface RoundValue {
  round: IntroductionRound | undefined;
  emptyReason: DailyRoundEmptyReason | null;
  /** Which of the member's own must-haves to loosen first, when relevant. */
  narrowingCriterion: NarrowingCriterion | null;
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

  /**
   * How long each profile was read. Kept on the device and never sent — it
   * exists only to decide whether a single question is worth asking before the
   * round is submitted.
   */
  profileOpened: (introductionId: string) => void;
  profileClosed: (introductionId: string) => void;
  /**
   * At most one introduction worth asking about, and null far more often than
   * not. Nothing acts on this without the member saying so.
   */
  passCandidate: () => string | null;
  /** Turns a release into a deliberate pass, once the member has confirmed. */
  confirmPass: (introductionId: string) => Promise<void>;
  /**
   * Notes whoever was read longest but not kept, before the round is submitted.
   * Not confirmed: it costs the member nothing and is never shown to anyone.
   */
  recordSoftSelect: () => Promise<void>;

  submitting: boolean;
  /** Commits the surviving introductions. Resolves with the mutual matches. */
  submit: (keptIntroductionIds?: string[]) => Promise<string[]>;
  /** True once keeps are submitted — drives the "Nothing more today" state. */
  submitted: boolean;
  /** A mutual is held only until both members have an open conversation slot. */
  waitingForConnection: boolean;
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
  const [waitingForConnection, setWaitingForConnection] = useState(false);
  const [releasing, setReleasing] = useState<Record<string, true>>({});
  const [releaseFailure, setReleaseFailure] = useState<{ id: string; message: string } | null>(null);

  const {
    data: roundState,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [...queryKeys.round, tier],
    queryFn: () => fetchCurrentRoundState(tier),
  });

  const round = roundState?.round;
  const emptyReason = roundState?.status && roundState.status !== 'ready'
    ? roundState.status
    : null;

  const narrowingCriterion = roundState?.narrowingCriterion ?? null;

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

  // A ref, not state: reading a profile must never re-render the round, and the
  // timings are consulted once, at submission.
  const ledger = useRef(new DwellLedger()).current;

  // Backgrounding is not navigation, so nothing else stops the clock on an open
  // profile. Without this a member who takes a call mid-profile banks the whole
  // call against whoever was on screen, which moves somebody else to the bottom
  // of the set and asks about the wrong person.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') ledger.resume();
      else ledger.pause();
    });
    return () => subscription.remove();
  }, [ledger]);
  const profileOpened = useCallback((id: string) => ledger.opened(id), [ledger]);
  const profileClosed = useCallback((id: string) => ledger.closed(id), [ledger]);
  // The whole set, not just the survivors: the rule is about how the member
  // worked through everyone they were given, so the ones they let go still
  // count as having been read.
  const passCandidate = useCallback(
    () => inferPassCandidate(
      ledger.records(),
      (round?.introductions ?? []).map((item) => item.id),
      Object.keys(released)
    ),
    [ledger, released, round]
  );

  const softSelectMutation = useMutation({ mutationFn: softSelectIntroduction });
  const recordSoftSelect = useCallback(async () => {
    const candidate = inferSoftSelect(ledger.records(), Object.keys(released));
    if (!candidate) return;
    try {
      await softSelectMutation.mutateAsync(candidate);
    } catch {
      // A courtesy signal. Losing it must never cost the member their round.
    }
  }, [ledger, released, softSelectMutation]);

  const passMutation = useMutation({ mutationFn: passIntroduction });
  const confirmPass = useCallback(
    async (id: string) => {
      // Deliberately not fatal. The member has answered a question they were
      // asked as a courtesy; failing their submission over it would be a poor
      // trade, and the release is already recorded either way.
      try {
        await passMutation.mutateAsync(id);
      } catch {
        // Left as a plain release.
      }
    },
    [passMutation]
  );

  const submitMutation = useMutation({
    mutationFn: async (keptIntroductionIds: string[]) => {
      if (!round) return { mutualProfileIds: [] };
      return submitKeeps(round.id, keptIntroductionIds);
    },
    onSuccess: (result) => {
      setSubmitted(true);
      setWaitingForConnection((result.waitingMutualProfileIds?.length ?? 0) > 0);
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
    ledger.clear();
    setReleased({});
    setReleasing({});
    setReleaseFailure(null);
    setActiveId(null);
    setPopMode(false);
    setSubmitted(false);
    setWaitingForConnection(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.round });
  }, [ledger, queryClient]);

  useEffect(() => {
    // Query data is cleared at the auth boundary. These are interaction-local
    // values, so reset them separately before a different member sees a round.
    ledger.clear();
    setReleased({});
    setReleasing({});
    setReleaseFailure(null);
    setActiveId(null);
    setPopMode(false);
    setSubmitted(false);
    setWaitingForConnection(false);
  }, [ledger, memberId]);

  const value = useMemo<RoundValue>(
    () => ({
      round,
      emptyReason,
      narrowingCriterion,
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
      profileOpened,
      profileClosed,
      passCandidate,
      confirmPass,
      recordSoftSelect,
      submitting: submitMutation.isPending,
      submit,
      submitted,
      waitingForConnection,
      submitError: submitMutation.error instanceof Error ? submitMutation.error.message : null,
      reset,
    }),
    [
      round,
      emptyReason,
      narrowingCriterion,
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
      profileOpened,
      profileClosed,
      passCandidate,
      confirmPass,
      recordSoftSelect,
      submitMutation.isPending,
      submit,
      submitted,
      waitingForConnection,
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
